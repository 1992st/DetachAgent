import type { CommandGuardResult, ToolRiskAssessment, ToolRequestKind } from "@detaches/shared";

export const commandGuardService = {
  assess(input: { kind: ToolRequestKind; payload: Record<string, unknown> }): CommandGuardResult {
    if (input.kind !== "terminal") {
      return { decision: "allow", riskLevel: input.kind === "skill-verify" ? "safe" : "elevated", matchedRules: [], normalizedCommand: "" };
    }
    const command = typeof input.payload.command === "string" ? input.payload.command : "";
    const normalizedCommand = command.trim().replace(/\s+/g, " ");
    const normalized = normalizedCommand.toLowerCase();
    const matchedRules: string[] = [];

    const destructive = [
      ["destructive.rm-root", /\brm\s+(-[a-z]*r[a-z]*f|-rf|-fr)\s+(\/|\$home\b|~\b|\.\.?\b)/i],
      ["destructive.sudo-rm", /\bsudo\s+rm\s+(-[a-z]*r[a-z]*f|-rf|-fr)\b/i],
      ["destructive.mkfs", /\bmkfs(\.[a-z0-9]+)?\b/i],
      ["destructive.dd-device", /\bdd\s+.*\bof=\/dev\//i],
      ["destructive.system-redirect", />\s*\/(?:etc|bin|sbin|usr|var|system|library)\b/i],
      ["destructive.download-pipe-shell", /\b(curl|wget)\b[\s\S]*\|\s*(sh|bash|zsh)\b/i]
    ] as const;
    for (const [id, pattern] of destructive) {
      if (pattern.test(command)) matchedRules.push(id);
    }
    if (matchedRules.length) {
      return {
        decision: "block",
        riskLevel: "destructive",
        matchedRules,
        guardReason: "Command matches destructive patterns that are blocked before Tool Queue approval.",
        normalizedCommand
      };
    }

    if (/\bsudo\b/.test(normalized)) matchedRules.push("elevated.sudo");
    if (/\b(chmod|chown)\b/.test(normalized)) matchedRules.push("elevated.permissions");
    if (/\b(npm|pnpm|yarn|pip|brew)\s+(install|add|remove|uninstall)\b/.test(normalized)) matchedRules.push("elevated.package-manager");
    if (/(^|\s)(rm|mv|cp)\s+/.test(normalized) && /(?:\/etc|\/usr|\/var|\/bin|\/sbin|~\/\.|\.ssh|\.zshrc|\.bashrc|\.profile)/.test(normalized)) {
      matchedRules.push("elevated.sensitive-path");
    }
    if (/\b(curl|wget)\b/.test(normalized) && /\b(sh|bash|zsh|chmod|python|node)\b/.test(normalized)) {
      matchedRules.push("warn.network-execution");
    }
    if (/\b(nohup|launchctl|systemctl|pm2|forever)\b/.test(normalized)) {
      matchedRules.push("warn.background-process");
    }

    if (matchedRules.some((rule) => rule.startsWith("elevated."))) {
      return {
        decision: "require-confirmation",
        riskLevel: "elevated",
        matchedRules,
        guardReason: "Command requires explicit user confirmation because it may modify system state.",
        normalizedCommand
      };
    }
    if (matchedRules.length) {
      return {
        decision: "warn",
        riskLevel: "safe",
        matchedRules,
        guardReason: "Command is allowed but has operational warnings.",
        normalizedCommand
      };
    }
    return { decision: "allow", riskLevel: "safe", matchedRules, normalizedCommand };
  },

  toToolRisk(guard: CommandGuardResult, fallback?: ToolRiskAssessment): ToolRiskAssessment {
    if (guard.riskLevel === "safe") return fallback?.level === "elevated" ? fallback : { level: "safe", reasons: [] };
    return {
      level: guard.riskLevel,
      reasons: [guard.guardReason || "Command Guard policy matched.", ...guard.matchedRules]
    };
  }
};
