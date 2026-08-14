import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FrameSink, getFrameLogPaths, type FrameRecord, type NodeRuntime } from "./debugSink";

/**
 * Real-filesystem proof of the frame log's permission boundary (#250): the
 * per-vault log directory chain must be owner-only (0700), both log
 * generations 0600, pre-existing permissive paths from older builds must be
 * narrowed on first use, and squatted paths (symlinks, foreign owners) must
 * never be written through. The fake-runtime suite in `debugSink.test.ts`
 * proves queueing/rotation logic; only a real filesystem can prove mode bits
 * and symlink behavior, so these run on POSIX and skip on win32 (no POSIX
 * mode bits there).
 */
const describePosix = process.platform === "win32" ? describe.skip : describe;

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
      return { uid: st.uid, isDirectory: st.isDirectory(), isSymbolicLink: st.isSymbolicLink() };
    },
    getuid: process.getuid ? () => process.getuid() : undefined,
    openPath: async () => "",
  };
}

function makeFrame(overrides: Partial<FrameRecord> = {}): FrameRecord {
  return {
    ts: "2026-08-14T00:00:00.000Z",
    dir: "→",
    tag: "claude-sdk",
    kind: "notif",
    method: "session/update",
    id: null,
    payload: { ok: true },
    ...overrides,
  };
}

const modeOf = (p: string): number => fsSync.statSync(p).mode & 0o777;
const exists = (p: string): boolean => fsSync.existsSync(p);

describePosix("debugSink (real fs)", () => {
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

  describe("FrameSink", () => {
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

      it("narrows a pre-existing permissive directory and both log generations from an older build", async () => {
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

      it("removes a symlink squatting the leaf directory and never writes through it", async () => {
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

      it("refuses a plain file squatting a directory level without deleting it", async () => {
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

      it("removes a dangling symlink squatting the leaf directory path", async () => {
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

      it("removes a symlink squatting the log file itself and leaves its target untouched", async () => {
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

      it("refuses to write into a directory owned by another user instead of falling back", async () => {
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
      it("does not delete through a symlink squatting the leaf directory", async () => {
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
