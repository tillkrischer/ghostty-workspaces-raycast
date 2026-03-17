import { Action, ActionPanel, Icon, List, Toast, closeMainWindow, showToast } from "@raycast/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);
const APPLESCRIPT_FIELD_SEPARATOR = String.fromCharCode(31);

type OpenWorkspace = {
  kind: "open";
  id: string;
  dir: string;
  displayDir: string;
};

type NewWorkspace = {
  kind: "new";
  id: string;
  dir: string;
  displayDir: string;
};

type WorkspaceData = {
  openWorkspaces: OpenWorkspace[];
  newWorkspaces: NewWorkspace[];
};

let cachedZoxidePath: string | null = null;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function workspaceTitle(dir: string, displayDir: string) {
  const normalized = displayDir === "~" ? "home" : displayDir.replace(/^~\//, "").replace(/^\//, "");
  const parts = normalized.split("/").filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }

  if (parts.length === 1) {
    return parts[0];
  }

  const base = path.basename(dir);
  return base && base !== "/" ? base : displayDir;
}

async function runAppleScript(script: string, args: string[] = []) {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("osascript", ["-", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(stderr.trim() || `osascript exited with code ${code}`));
    });

    child.stdin.write(script);
    child.stdin.end();
  });
}

async function pathExists(targetPath: string) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveZoxidePath() {
  if (cachedZoxidePath) {
    return cachedZoxidePath;
  }

  const candidates = [
    process.env.HOMEBREW_PREFIX ? path.join(process.env.HOMEBREW_PREFIX, "bin", "zoxide") : null,
    "/opt/homebrew/bin/zoxide",
    "/usr/local/bin/zoxide",
    path.join(process.env.HOME ?? "", ".local", "bin", "zoxide"),
    "zoxide",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (candidate === "zoxide") {
      try {
        await execFileAsync(candidate, ["--version"]);
        cachedZoxidePath = candidate;
        return candidate;
      } catch {
        continue;
      }
    }

    if (await pathExists(candidate)) {
      cachedZoxidePath = candidate;
      return candidate;
    }
  }

  throw new Error("Could not find zoxide. Tried /opt/homebrew/bin/zoxide, /usr/local/bin/zoxide, ~/.local/bin/zoxide, and PATH.");
}

function displayPath(dir: string) {
  const homeDir = process.env.HOME;

  if (!homeDir) {
    return dir;
  }

  if (dir === homeDir) {
    return "~";
  }

  if (dir.startsWith(`${homeDir}/`)) {
    return `~${dir.slice(homeDir.length)}`;
  }

  return dir;
}

async function canonicalDir(dir: string) {
  const expanded = dir.startsWith("~") ? path.join(process.env.HOME ?? "", dir.slice(1)) : dir;
  return path.resolve(expanded);
}

async function getOpenWorkspaces() {
  const script = String.raw`
set outputLines to {}
set fieldSeparator to character id 31

if application "Ghostty" is running then
  tell application "Ghostty"
    repeat with currentWindow in windows
      try
        set windowId to id of currentWindow
        set workspaceDir to working directory of focused terminal of selected tab of currentWindow

        if workspaceDir is not missing value and workspaceDir is not "" then
          set end of outputLines to (windowId & fieldSeparator & workspaceDir)
        end if
      end try
    end repeat
  end tell
end if

set AppleScript's text item delimiters to linefeed
return outputLines as text
`;

  const stdout = await runAppleScript(script);
  if (!stdout) {
    return [] as OpenWorkspace[];
  }

  const seen = new Set<string>();
  const entries = await Promise.all(
    stdout
      .split("\n")
      .filter(Boolean)
      .map(async (line) => {
        const [windowId, rawDir] = line.split(APPLESCRIPT_FIELD_SEPARATOR);
        if (!windowId || !rawDir) {
          return null;
        }

        const dir = await canonicalDir(rawDir);
        if (!(await pathExists(dir)) || seen.has(dir)) {
          return null;
        }

        seen.add(dir);
        return {
          kind: "open" as const,
          id: windowId,
          dir,
          displayDir: displayPath(dir),
        };
      }),
  );

  return entries.filter((entry): entry is OpenWorkspace => entry !== null);
}

async function getZoxideDirs() {
  const zoxidePath = await resolveZoxidePath();
  const result = await execFileAsync(zoxidePath, ["query", "-l"]);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function loadWorkspaceData(): Promise<WorkspaceData> {
  const openWorkspaces = await getOpenWorkspaces();
  const openDirs = new Set(openWorkspaces.map((workspace) => workspace.dir));
  const zoxideDirs = await getZoxideDirs();
  const newWorkspaces: NewWorkspace[] = [];
  const seenDirs = new Set(openDirs);

  for (const dir of zoxideDirs) {
    const resolvedDir = await canonicalDir(dir);
    if (!(await pathExists(resolvedDir)) || seenDirs.has(resolvedDir)) {
      continue;
    }

    seenDirs.add(resolvedDir);
    newWorkspaces.push({
      kind: "new",
      id: resolvedDir,
      dir: resolvedDir,
      displayDir: displayPath(resolvedDir),
    });
  }

  return {
    openWorkspaces,
    newWorkspaces,
  };
}

async function activateWorkspace(windowId: string) {
  const script = String.raw`
on run argv
  set targetWindowId to item 1 of argv

  tell application "Ghostty"
    activate window (first window whose id is targetWindowId)
  end tell
end run
`;

  await runAppleScript(script, [windowId]);
}

async function setWorkspaceTitle(windowId: string, title: string) {
  const script = String.raw`
on run argv
  set targetWindowId to item 1 of argv
  set targetTitle to item 2 of argv

  tell application "Ghostty"
    tell first window whose id is targetWindowId
      tell focused terminal of selected tab
        perform action ("set_tab_title:" & targetTitle) on it
      end tell
    end tell
  end tell
end run
`;

  await runAppleScript(script, [windowId, title]);
}

async function openWorkspace(dir: string, title: string) {
  const script = String.raw`
on run argv
  set targetDir to item 1 of argv
  set targetTitle to item 2 of argv

  tell application "Ghostty"
    set cfg to new surface configuration
    set initial working directory of cfg to targetDir
    set newWindow to new window with configuration cfg
    tell focused terminal of selected tab of newWindow
      perform action ("set_tab_title:" & targetTitle) on it
    end tell
    activate window newWindow
  end tell
end run
`;

  await runAppleScript(script, [dir, title]);
}

async function revealInFinder(dir: string) {
  await execFileAsync("open", [dir]);
}

async function runAction(title: string, action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    const message = errorMessage(error);
    console.error(`[ghostty-workspaces] ${title} failed: ${message}`, error);
    await showToast({
      style: Toast.Style.Failure,
      title,
      message,
    });
  }
}

async function runWorkspaceAction(title: string, action: () => Promise<void>, reload: () => Promise<void>) {
  await runAction(title, async () => {
    await action();
    await reload();
    await closeMainWindow();
  });
}

export default function Command() {
  const [data, setData] = useState<WorkspaceData>({ openWorkspaces: [], newWorkspaces: [] });
  const [isLoading, setIsLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setIsLoading(true);
      setData(await loadWorkspaceData());
    } catch (error) {
      const message = errorMessage(error);
      console.error(`[ghostty-workspaces] Failed to load workspaces: ${message}`, error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to load workspaces",
        message,
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const hasItems = useMemo(() => data.openWorkspaces.length > 0 || data.newWorkspaces.length > 0, [data]);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search Ghostty workspaces">
      {!isLoading && !hasItems ? (
        <List.EmptyView title="No workspaces found" description="No open Ghostty windows and no zoxide directories available." />
      ) : null}

      <List.Section title="Open Workspaces" subtitle={String(data.openWorkspaces.length)}>
        {data.openWorkspaces.map((workspace) => (
          <List.Item
            key={workspace.id}
            icon={Icon.AppWindow}
            title={workspaceTitle(workspace.dir, workspace.displayDir)}
            subtitle={workspace.displayDir}
            keywords={[workspace.dir, workspace.displayDir]}
            actions={
              <ActionPanel>
                <Action
                  title="Switch to Workspace"
                  onAction={() =>
                    runWorkspaceAction(
                      "Failed to switch workspace",
                      async () => {
                        await setWorkspaceTitle(workspace.id, workspaceTitle(workspace.dir, workspace.displayDir));
                        await activateWorkspace(workspace.id);
                      },
                      reload,
                    )
                  }
                  icon={Icon.ArrowRight}
                />
                <Action
                  title="Reveal in Finder"
                  onAction={() => runAction("Failed to reveal workspace", () => revealInFinder(workspace.dir))}
                  icon={Icon.Finder}
                />
                <Action.CopyToClipboard title="Copy Path" content={workspace.dir} />
                <Action title="Refresh" onAction={reload} icon={Icon.ArrowClockwise} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>

      <List.Section title="Zoxide" subtitle={String(data.newWorkspaces.length)}>
        {data.newWorkspaces.map((workspace) => (
          <List.Item
            key={workspace.id}
            icon={Icon.Folder}
            title={workspaceTitle(workspace.dir, workspace.displayDir)}
            subtitle={workspace.displayDir}
            keywords={[workspace.dir, workspace.displayDir]}
            actions={
              <ActionPanel>
                <Action
                  title="Open New Workspace"
                  onAction={() =>
                    runWorkspaceAction(
                      "Failed to open workspace",
                      () => openWorkspace(workspace.dir, workspaceTitle(workspace.dir, workspace.displayDir)),
                      reload,
                    )
                  }
                  icon={Icon.Plus}
                />
                <Action
                  title="Reveal in Finder"
                  onAction={() => runAction("Failed to reveal workspace", () => revealInFinder(workspace.dir))}
                  icon={Icon.Finder}
                />
                <Action.CopyToClipboard title="Copy Path" content={workspace.dir} />
                <Action title="Refresh" onAction={reload} icon={Icon.ArrowClockwise} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
