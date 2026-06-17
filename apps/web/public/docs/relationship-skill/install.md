# Relationship Skill Git Install Guide

This document is the standalone install guide for `detach-agent-relationship`.
It is intended to be published with the Git repository so users can download the
skill without using the Detach Agent diagnostic page.

## What To Install

Install the skill on the machine that runs the Host/Main Agent. Do not install it
on the detached runtime machine unless that same machine is also running the
Host/Main Agent.

The expected installed path is usually:

```text
~/.openclaw/skills/detach-agent-relationship
```

If the Host/Main Agent uses a custom skills directory, install into that
directory instead. Do not guess the path for remote machines; confirm it from the
Host/Main Agent environment.

## Download Options

Use one of these sources from this repository:

- Source directory: `skills/detach-agent-relationship/`
- Packaged skill archive: `detach-agent-relationship.skill.zip`
- Windows offline package: `dist/detach-agent-windows-installer.zip`

When this project is hosted on Git, users can either clone the repository or
download the packaged `detach-agent-relationship.skill.zip` release artifact.

## Install From A Git Clone

Run these commands on the Host/Main Agent computer:

```bash
git clone <repo-url>
cd <repo-directory>
mkdir -p ~/.openclaw/skills
rm -rf ~/.openclaw/skills/detach-agent-relationship
cp -R skills/detach-agent-relationship ~/.openclaw/skills/detach-agent-relationship
```

Then restart the Host/Main Agent session or refresh the OpenClaw skill index so
the new skill can be discovered.

## Install From The Skill Zip

Run these commands on the Host/Main Agent computer:

```bash
mkdir -p ~/.openclaw/skills
unzip -q -o detach-agent-relationship.skill.zip -d ~/.openclaw/skills
```

The zip must extract to this folder structure:

```text
~/.openclaw/skills/detach-agent-relationship/
  SKILL.md
  README.md
  VERSION
```

Then restart the Host/Main Agent session or refresh the OpenClaw skill index.

## Remote Host Notes

If the detached app is running on one computer and the Host/Main Agent is running
on another computer, the skill must end up on the Host/Main Agent computer.

Two valid transfer patterns are:

- Push: the local Detach Agent sends or copies the skill package to the Host/Main
  Agent computer.
- Pull: the Host/Main Agent computer downloads the skill from Git or pulls it
  from a shared location.

Pull is often friendlier when SSH from the local machine to the Host/Main Agent
is blocked or when host key approval is not already configured. In that case,
publish the zip or repository somewhere the Host/Main Agent computer can access,
then run the install commands there.

## Verify Installation

Run these checks on the Host/Main Agent computer:

```bash
test -f ~/.openclaw/skills/detach-agent-relationship/SKILL.md
test -f ~/.openclaw/skills/detach-agent-relationship/README.md
test -f ~/.openclaw/skills/detach-agent-relationship/VERSION
cat ~/.openclaw/skills/detach-agent-relationship/VERSION
```

The current package version is recorded in `VERSION`.

## Troubleshooting

`Skill directory missing`

The Host/Main Agent is looking in a skills path that does not contain
`detach-agent-relationship`. Install the skill into the Host/Main Agent skills
directory, not only into the local Detach Agent cache.

`Local cache is ready, but OpenClaw still cannot see it`

The package exists in a Detach Agent cache path such as
`~/.detach_agent/skills/detach-agent-relationship`, but it has not been copied
into the active OpenClaw skills directory. Run the install step on the Host/Main
Agent computer.

`Installed locally, but the Main Agent computer does not show the skill`

The skill was installed on the wrong machine. Copy, pull, or unzip it on the
computer where the Host/Main Agent process runs.

`Zip extracted, but the skill is still broken`

Check that the zip contains a top-level `detach-agent-relationship/` folder and
that `SKILL.md`, `README.md`, and `VERSION` are inside that folder.

`Skill exists, but the agent does not use it`

Restart the Host/Main Agent session or refresh/reindex the OpenClaw skills. Some
agents only load skills when a new session starts.
