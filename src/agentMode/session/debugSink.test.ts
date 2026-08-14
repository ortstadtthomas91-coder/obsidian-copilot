import { FrameRecord, FrameSink, getFrameLogPaths, NodeRuntime } from "./debugSink";

function makeFrame(id: string): FrameRecord {
  return {
    ts: "2026-05-12T00:00:00.000Z",
    dir: "→",
    tag: "codex",
    kind: "notif",
    method: "session/update",
    id,
    payload: { ok: true },
  };
}

interface FakeRuntime extends NodeRuntime {
  files: Map<string, string>;
  directories: Set<string>;
  removedPaths: string[];
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** Create an in-memory runtime for exercising the frame sink without disk IO. */
function makeRuntime(tmpDir = "/tmp"): FakeRuntime {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const removedPaths: string[] = [];
  const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");
  return {
    files,
    directories,
    removedPaths,
    tmpdir: () => tmpDir,
    join,
    dirname: (path) => path.slice(0, path.lastIndexOf("/")) || "/",
    mkdir: jest.fn(async (path) => {
      directories.add(path);
    }),
    appendFile: jest.fn(async (path, data) => {
      files.set(path, (files.get(path) ?? "") + data);
    }),
    writeFile: jest.fn(async (path, data) => {
      files.set(path, data);
    }),
    rm: jest.fn(async (path) => {
      removedPaths.push(path);
      files.delete(path);
      directories.delete(path);
    }),
    stat: jest.fn(async (path) => {
      const data = files.get(path);
      if (data === undefined) throw errno("ENOENT");
      return { size: data.length };
    }),
    rename: jest.fn(async (oldPath, newPath) => {
      const data = files.get(oldPath);
      if (data === undefined) throw errno("ENOENT");
      files.set(newPath, data);
      files.delete(oldPath);
    }),
    chmod: jest.fn(async () => undefined),
    // Known files are plain files, mkdir-ed paths plain directories, anything
    // else ENOENT — all owned by uid 1000, so path validation passes and the
    // queueing tests stay focused. Squatting scenarios live in the real-fs
    // suite (`debugSink.realfs.test.ts`).
    lstat: jest.fn(async (path: string) => {
      if (files.has(path)) return { uid: 1000, isDirectory: false, isSymbolicLink: false };
      if (directories.has(path)) return { uid: 1000, isDirectory: true, isSymbolicLink: false };
      throw errno("ENOENT");
    }),
    getuid: () => 1000,
    openPath: jest.fn(async () => ""),
  };
}

describe("debugSink", () => {
  describe("getFrameLogPaths()", () => {
    it("stores frame logs in stable, distinct per-vault temp directories", () => {
      const runtime = makeRuntime("C:/Users/zero/AppData/Local/Temp");
      const first = getFrameLogPaths("C:/Users/zero/Vault", runtime);
      const second = getFrameLogPaths("C:/Users/zero/OtherVault", runtime);

      expect(first.logPath).toContain("/obsidian-copilot/acp-frames/");
      expect(first.logPath).toMatch(/\/acp-frames\.ndjson$/);
      expect(first.rotatedPath).toMatch(/\/acp-frames\.old\.ndjson$/);
      expect(first.dirPath).not.toBe(second.dirPath);
    });
  });

  describe("FrameSink", () => {
    describe("append()", () => {
      it("summarizes oversized frames before appending", async () => {
        const runtime = makeRuntime();
        const sink = new FrameSink({ vaultBasePath: "/vault", runtime });
        const paths = getFrameLogPaths("/vault", runtime);

        sink.append({
          ts: "2026-05-12T00:00:00.000Z",
          dir: "←",
          tag: "codex",
          kind: "notif",
          method: "session/update",
          id: null,
          payload: {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "call-1",
            },
            content: "x".repeat(100_000),
          },
        });
        await sink.flush();

        const log = runtime.files.get(paths.logPath) ?? "";
        expect(log.length).toBeLessThan(5_000);
        expect(log).toContain('"__truncated":true');
        expect(log).toContain("sessionUpdate=tool_call_update");
        expect(log).toContain("toolCallId=call-1");
      });

      it("drops the frame instead of writing when path validation fails, then recovers", async () => {
        const runtime = makeRuntime();
        const lstat = runtime.lstat as jest.MockedFunction<NodeRuntime["lstat"]>;
        // First ensure pass dies on an unreadable path — e.g. a directory the
        // sink may not traverse. Nothing may be written in response.
        lstat.mockRejectedValueOnce(errno("EACCES"));
        const sink = new FrameSink({ vaultBasePath: "/vault", runtime });
        const paths = getFrameLogPaths("/vault", runtime);

        sink.append(makeFrame("first"));
        await sink.flush();
        expect(runtime.appendFile).not.toHaveBeenCalled();
        expect(runtime.writeFile).not.toHaveBeenCalled();

        // The failed ensure was not cached: the next frame re-validates and
        // lands normally.
        sink.append(makeFrame("second"));
        await sink.flush();
        expect(runtime.files.get(paths.logPath)).toContain('"id":"second"');
      });
    });

    describe("clear()", () => {
      it("clears active and rotated log files", async () => {
        const runtime = makeRuntime();
        const sink = new FrameSink({ vaultBasePath: "/vault", runtime });
        const paths = getFrameLogPaths("/vault", runtime);
        runtime.files.set(paths.logPath, "active");
        runtime.files.set(paths.rotatedPath, "old");

        await sink.clear();

        expect(runtime.files.has(paths.logPath)).toBe(false);
        expect(runtime.files.has(paths.rotatedPath)).toBe(false);
        expect(runtime.removedPaths).toEqual(
          expect.arrayContaining([paths.logPath, paths.rotatedPath])
        );
      });

      it("deletes nothing when path validation fails", async () => {
        const runtime = makeRuntime();
        const lstat = runtime.lstat as jest.MockedFunction<NodeRuntime["lstat"]>;
        lstat.mockRejectedValueOnce(errno("EACCES"));
        const sink = new FrameSink({ vaultBasePath: "/vault", runtime });
        const paths = getFrameLogPaths("/vault", runtime);
        runtime.files.set(paths.logPath, "active");

        await expect(sink.clear()).rejects.toThrow("EACCES");

        expect(runtime.rm).not.toHaveBeenCalled();
        expect(runtime.files.has(paths.logPath)).toBe(true);
      });
    });
  });
});
