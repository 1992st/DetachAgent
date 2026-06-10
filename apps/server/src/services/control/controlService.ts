import type { ControlStatus } from "@detaches/shared";

export function getControlStatus(): ControlStatus {
  return {
    state: "disabled",
    message: "Remote control is reserved for the next phase and will require approval, audit logs, timeouts, and permission boundaries."
  };
}
