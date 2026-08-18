import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FrameRecord, FrameSink, getFrameLogPaths, NodeRuntime } from "./debugSink";

function makeFrame(overrides: Partial<FrameRecord> = {}): FrameRecord {
  return {
    ts: "2026-05-12T00:00:00.000Z",
    dir: "→",
    tag: "codex",
    kind: "notif",
    method: "session/update",
    id: null,
    payload: { ok: true },
    ...overrides,
  };
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

interface FakeRuntime extends NodeRuntime {
  files: Map<string, string>;
  directories: Set<string>;
  removedPaths: string[];
}

/** Create an in-memory runtime for exercising the frame sink without disk IO. */
function makeRuntime(tmpDir = "/tmp", tempRootMode = 0o1755): FakeRuntime {
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
    // groups below.
    lstat: jest.fn(async (path: string) => {
      // Root directory: always owned by root (uid 0), mode 0755.
      if (path === "/") {
        return { uid: 0, mode: 0o755, isDirectory: true, isSymbolicLink: false };
      }
      if (path === tmpDir) {
        return { uid: 1000, mode: tempRootMode, isDirectory: true, isSymbolicLink: false };
      }
      if (files.has(path)) {
        return { uid: 1000, mode: 0o600, isDirectory: false, isSymbolicLink: false };
      }
      if (directories.has(path)) {
        return { uid: 1000, mode: 0o700, isDirectory: true, isSymbolicLink: false };
      }
      throw errno("ENOENT");
    }),
    getuid: () => 1000,
    openPath: jest.fn(async () => ""),
  };
}

/** Real-fs NodeRuntime mirroring production `getNodeRuntime`, pinned to a temp base. */
function makeRealRuntime(tmpBase: string): NodeRuntime {
  return {
    tmpdir: () => tmpBase,
    join: (...segs: string[]) => path.join(...segs),
    dirname: (p: string) => path.dirname(p),
    mkdir: async (dirPath, opts) => {
      await fs.mkdir(dirPath, opts);
    },
    appendFile: fs.appendFile,
    writeFile: fs.writeFile,
    rm: fs.rm,
    stat: fs.stat,
    rename: fs.rename,
    chmod: fs.chmod,
    lstat: async (p) => {
      const st = await fs.lstat(p);
      return {
        uid: st.uid,
        mode: st.mode,
        isDirectory: st.isDirectory(),
        isSymbolicLink: st.isSymbolicLink(),
      };
    },
    getuid: process.getuid ? () => process.getuid() : undefined,
    openPath: async () => "",
  };
}

const modeOf = (p: string): number => fsSync.statSync(p).mode & 0o777;
const exists = (p: string): boolean => fsSync.existsSync(p);
const describePosix = process.platform === "win32" ? describe.skip : describe;

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

        sink.append(
          makeFrame({
            dir: "←",
            payload: {
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "call-1",
              },
              content: "x".repeat(100_000),
            },
          })
        );
        await sink.flush();

        const log = runtime.files.get(paths.logPath) ?? "";
        expect(log.length).toBeLessThan(5_000);
        expect(log).toContain('"__truncated":true');
        expect(log).toContain("sessionUpdate=tool_call_update");
        expect(log).toContain("toolCallId=call-1");
      });

      it("refuses to cache when temp root is group-writable without sticky bit (https://github.com/logancyang/obsidian-copilot-preview/issues/250)", async () => {
        const runtime = makeRuntime("/tmp", 0o770);
        const lstat = runtime.lstat as jest.MockedFunction<NodeRuntime["lstat"]>;
        const sink = new FrameSink({ vaultBasePath: "/vault", runtime });

        sink.append(makeFrame({ id: "first" }));
        await sink.flush();
        sink.append(makeFrame({ id: "second" }));
        await sink.flush();

        expect(runtime.appendFile).not.toHaveBeenCalled();
        expect(lstat.mock.calls.filter(([path]) => path === runtime.tmpdir())).toHaveLength(2);
      });

      it.each([
        { condition: "group-writable without sticky bit", parentUid: 0, parentMode: 0o777 },
        { condition: "owned by another user", parentUid: 2000, parentMode: 0o755 },
      ])(
        "refuses to cache when temp root parent is $condition (https://github.com/logancyang/obsidian-copilot-preview/issues/250)",
        async ({ parentUid, parentMode }) => {
          const runtime = makeRuntime("/shared/alice-tmp", 0o700);
          const lstat = runtime.lstat as jest.MockedFunction<NodeRuntime["lstat"]>;
          // The temp root is owner-only, but another account can replace it
          // through shared-write or through ownership of the parent directory.
          lstat.mockImplementation(async (path: string) => {
            if (path === "/shared/alice-tmp") {
              return { uid: 1000, mode: 0o700, isDirectory: true, isSymbolicLink: false };
            }
            if (path === "/shared") {
              return {
                uid: parentUid,
                mode: parentMode,
                isDirectory: true,
                isSymbolicLink: false,
              };
            }
            throw errno("ENOENT");
          });
          const sink = new FrameSink({ vaultBasePath: "/vault", runtime });

          sink.append(makeFrame({ id: "first" }));
          await sink.flush();
          sink.append(makeFrame({ id: "second" }));
          await sink.flush();

          expect(runtime.appendFile).not.toHaveBeenCalled();
          expect(lstat.mock.calls.filter(([path]) => path === "/shared")).toHaveLength(2);
        }
      );

      it("drops the frame instead of writing when path validation fails, then recovers (https://github.com/logancyang/obsidian-copilot-preview/issues/250)", async () => {
        const runtime = makeRuntime();
        const lstat = runtime.lstat as jest.MockedFunction<NodeRuntime["lstat"]>;
        // First ensure pass dies on an unreadable path — e.g. a directory the
        // sink may not traverse. Nothing may be written in response.
        lstat.mockRejectedValueOnce(errno("EACCES"));
        const sink = new FrameSink({ vaultBasePath: "/vault", runtime });
        const paths = getFrameLogPaths("/vault", runtime);

        sink.append(makeFrame({ id: "first" }));
        await sink.flush();
        expect(runtime.appendFile).not.toHaveBeenCalled();
        expect(runtime.writeFile).not.toHaveBeenCalled();

        // The failed ensure was not cached: the next frame re-validates and
        // lands normally.
        sink.append(makeFrame({ id: "second" }));
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

      it("deletes nothing when path validation fails (https://github.com/logancyang/obsidian-copilot-preview/issues/250)", async () => {
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

    // The groups below re-exercise append()/open()/clear() against the REAL
    // filesystem, proving the frame log's owner-only permission boundary:
    // mode bits under several umasks, narrowing of paths left permissive by
    // older builds, and squatted-path containment — none of which the
    // in-memory runtime can prove.
    // https://github.com/logancyang/obsidian-copilot-preview/issues/250
    // They stay separate same-callable groups (as AGENTS.md's lifecycle
    // exception allows) because they carry a material lifecycle of their own:
    // a per-test mkdtemp sandbox, process-umask save/restore, and a
    // POSIX-only skip (win32 has no POSIX mode bits).
    describePosix("on the real filesystem (POSIX)", () => {
      let tmpBase: string;
      let prevUmask: number;

      beforeEach(async () => {
        tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "frame-sink-realfs-"));
        prevUmask = process.umask(0o022);
      });

      afterEach(async () => {
        process.umask(prevUmask);
        await fs.rm(tmpBase, { recursive: true, force: true });
      });

      describe("append()", () => {
        it.each([[0o000], [0o022], [0o077]])(
          "creates the directory chain 0700 and the log file 0600 under umask %o",
          async (umask) => {
            process.umask(umask);
            const runtime = makeRealRuntime(tmpBase);
            const sink = new FrameSink({ vaultBasePath: "/vault", runtime });
            const paths = getFrameLogPaths("/vault", runtime);

            sink.append(makeFrame());
            await sink.flush();

            expect(exists(paths.logPath)).toBe(true);
            // Every level of the predictable chain is owner-only, not just the leaf.
            expect(modeOf(paths.dirPath)).toBe(0o700);
            expect(modeOf(path.dirname(paths.dirPath))).toBe(0o700);
            expect(modeOf(path.dirname(path.dirname(paths.dirPath)))).toBe(0o700);
            expect(modeOf(paths.logPath)).toBe(0o600);
          }
        );

        it("narrows a pre-existing permissive directory and both log generations from an older build (https://github.com/logancyang/obsidian-copilot-preview/issues/250)", async () => {
          const runtime = makeRealRuntime(tmpBase);
          const paths = getFrameLogPaths("/vault", runtime);
          process.umask(0o000);
          await fs.mkdir(paths.dirPath, { recursive: true });
          await fs.writeFile(paths.logPath, "old-active\n", { mode: 0o644 });
          await fs.writeFile(paths.rotatedPath, "old-rotated\n", { mode: 0o644 });
          expect(modeOf(paths.dirPath)).toBe(0o777);

          const sink = new FrameSink({ vaultBasePath: "/vault", runtime });
          sink.append(makeFrame());
          await sink.flush();

          expect(modeOf(paths.dirPath)).toBe(0o700);
          expect(modeOf(paths.logPath)).toBe(0o600);
          expect(modeOf(paths.rotatedPath)).toBe(0o600);
          // The pre-existing content survived — narrowing must not truncate.
          const content = await fs.readFile(paths.logPath, "utf8");
          expect(content).toContain("old-active");
          expect(content).toContain('"session/update"');
        });

        it("removes a symlink squatting the leaf directory and never writes through it (https://github.com/logancyang/obsidian-copilot-preview/issues/250)", async () => {
          const runtime = makeRealRuntime(tmpBase);
          const paths = getFrameLogPaths("/vault", runtime);
          const victim = path.join(tmpBase, "victim");
          await fs.mkdir(victim, { recursive: true });
          await fs.mkdir(path.dirname(paths.dirPath), { recursive: true });
          await fs.symlink(victim, paths.dirPath);

          const sink = new FrameSink({ vaultBasePath: "/vault", runtime });
          sink.append(makeFrame());
          await sink.flush();

          // The victim directory never received the log file.
          expect(exists(path.join(victim, "acp-frames.ndjson"))).toBe(false);
          // The squatting link was replaced by a real owner-only directory.
          const leaf = await fs.lstat(paths.dirPath);
          expect(leaf.isSymbolicLink()).toBe(false);
          expect(leaf.isDirectory()).toBe(true);
          expect(modeOf(paths.dirPath)).toBe(0o700);
          expect(modeOf(paths.logPath)).toBe(0o600);
        });

        it("refuses a plain file squatting a directory level without deleting it (https://github.com/logancyang/obsidian-copilot-preview/issues/250)", async () => {
          const runtime = makeRealRuntime(tmpBase);
          const paths = getFrameLogPaths("/vault", runtime);
          await fs.mkdir(path.dirname(paths.dirPath), { recursive: true });
          // A plain file may be content someone owns — unlike a symlink it is
          // never removed; the sink fails closed instead.
          await fs.writeFile(paths.dirPath, "someone's data", { mode: 0o644 });

          const sink = new FrameSink({ vaultBasePath: "/vault", runtime });
          sink.append(makeFrame());
          await sink.flush();

          const leaf = await fs.lstat(paths.dirPath);
          expect(leaf.isFile()).toBe(true);
          expect(await fs.readFile(paths.dirPath, "utf8")).toBe("someone's data");
          expect(exists(paths.logPath)).toBe(false);
        });

        it("removes a dangling symlink squatting the leaf directory path (https://github.com/logancyang/obsidian-copilot-preview/issues/250)", async () => {
          const runtime = makeRealRuntime(tmpBase);
          const paths = getFrameLogPaths("/vault", runtime);
          await fs.mkdir(path.dirname(paths.dirPath), { recursive: true });
          await fs.symlink(path.join(tmpBase, "nowhere"), paths.dirPath);

          const sink = new FrameSink({ vaultBasePath: "/vault", runtime });
          sink.append(makeFrame());
          await sink.flush();

          const leaf = await fs.lstat(paths.dirPath);
          expect(leaf.isSymbolicLink()).toBe(false);
          expect(leaf.isDirectory()).toBe(true);
          expect(modeOf(paths.dirPath)).toBe(0o700);
          expect(modeOf(paths.logPath)).toBe(0o600);
        });

        it("removes a symlink squatting the log file itself and leaves its target untouched (https://github.com/logancyang/obsidian-copilot-preview/issues/250)", async () => {
          const runtime = makeRealRuntime(tmpBase);
          const paths = getFrameLogPaths("/vault", runtime);
          const victimFile = path.join(tmpBase, "victim.txt");
          await fs.writeFile(victimFile, "victim-content", { mode: 0o644 });
          await fs.mkdir(paths.dirPath, { recursive: true });
          await fs.symlink(victimFile, paths.logPath);

          const sink = new FrameSink({ vaultBasePath: "/vault", runtime });
          sink.append(makeFrame());
          await sink.flush();

          // The victim was neither chmodded nor appended to.
          expect(await fs.readFile(victimFile, "utf8")).toBe("victim-content");
          expect(modeOf(victimFile)).toBe(0o644);
          // The log landed in a fresh private regular file.
          const log = await fs.lstat(paths.logPath);
          expect(log.isSymbolicLink()).toBe(false);
          expect(modeOf(paths.logPath)).toBe(0o600);
        });

        it("refuses to write into a directory owned by another user instead of falling back (https://github.com/logancyang/obsidian-copilot-preview/issues/250)", async () => {
          const runtime = makeRealRuntime(tmpBase);
          // Simulate a foreign owner: the on-disk uid can't differ without root,
          // so shift the runtime's idea of the current uid instead.
          runtime.getuid = () => process.getuid() + 1;
          const paths = getFrameLogPaths("/vault", runtime);

          const sink = new FrameSink({ vaultBasePath: "/vault", runtime });
          sink.append(makeFrame());
          await sink.flush();

          // No write landed anywhere — in particular no fallback recreate.
          expect(exists(paths.logPath)).toBe(false);
          expect(exists(paths.rotatedPath)).toBe(false);
        });

        it("creates the fresh post-rotation file 0600", async () => {
          const runtime = makeRealRuntime(tmpBase);
          const paths = getFrameLogPaths("/vault", runtime);
          await fs.mkdir(paths.dirPath, { recursive: true });
          // A sparse active file already past the rotation threshold.
          await fs.writeFile(paths.logPath, "", { mode: 0o644 });
          await fs.truncate(paths.logPath, 51 * 1024 * 1024);

          const sink = new FrameSink({ vaultBasePath: "/vault", runtime });
          // ROTATE_CHECK_EVERY (25) writes trigger the stat check and rename;
          // one more lands in the freshly created active file.
          for (let i = 0; i < 26; i++) sink.append(makeFrame({ id: String(i) }));
          await sink.flush();

          expect(exists(paths.rotatedPath)).toBe(true);
          expect(modeOf(paths.rotatedPath)).toBe(0o600);
          expect(modeOf(paths.logPath)).toBe(0o600);
        });
      });

      describe("open()", () => {
        it("creates a missing log file 0600 before opening it", async () => {
          const runtime = makeRealRuntime(tmpBase);
          const paths = getFrameLogPaths("/vault", runtime);
          const sink = new FrameSink({ vaultBasePath: "/vault", runtime });

          await sink.open();

          expect(exists(paths.logPath)).toBe(true);
          expect(modeOf(paths.logPath)).toBe(0o600);
          expect(modeOf(paths.dirPath)).toBe(0o700);
        });
      });

      describe("clear()", () => {
        it("does not delete through a symlink squatting the leaf directory (https://github.com/logancyang/obsidian-copilot-preview/issues/250)", async () => {
          const runtime = makeRealRuntime(tmpBase);
          const paths = getFrameLogPaths("/vault", runtime);
          const victim = path.join(tmpBase, "victim");
          await fs.mkdir(victim, { recursive: true });
          const victimLog = path.join(victim, "acp-frames.ndjson");
          await fs.writeFile(victimLog, "victim-data");
          await fs.mkdir(path.dirname(paths.dirPath), { recursive: true });
          await fs.symlink(victim, paths.dirPath);

          const sink = new FrameSink({ vaultBasePath: "/vault", runtime });
          await sink.clear();

          expect(exists(victimLog)).toBe(true);
        });
      });
    });
  });
});
