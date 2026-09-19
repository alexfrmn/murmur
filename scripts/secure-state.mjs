import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const currentUid = () => typeof process.getuid === "function" ? process.getuid() : undefined;

const assertOwned = (stats, target) => {
  const uid = currentUid();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`private-state-owner-mismatch:${target}`);
  }
};

const assertPrivateDirectory = async (dirPath) => {
  const stats = await lstat(dirPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`private-state-directory-invalid:${dirPath}`);
  }
  assertOwned(stats, dirPath);
};

const assertPrivateRegularFile = async (filePath) => {
  const stats = await lstat(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`private-state-file-invalid:${filePath}`);
  }
  assertOwned(stats, filePath);
};

export const setPrivateUmask = () => {
  process.umask(0o077);
};

export const ensurePrivateDirectory = async (dirPath) => {
  setPrivateUmask();
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(dirPath);
  await chmod(dirPath, 0o700);
};

export const readPrivateJson = async (filePath) => {
  setPrivateUmask();
  await assertPrivateDirectory(path.dirname(filePath));
  await assertPrivateRegularFile(filePath);
  await chmod(filePath, 0o600);

  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`private-state-file-invalid:${filePath}`);
    assertOwned(stats, filePath);
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
};

export const writePrivateJson = async (filePath, value) => {
  setPrivateUmask();
  const dirPath = path.dirname(filePath);
  await ensurePrivateDirectory(dirPath);

  try {
    await assertPrivateRegularFile(filePath);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }

  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
    await chmod(filePath, 0o600);

    // Windows does not support fsync on a directory handle (FlushFileBuffers
    // returns EPERM/EINVAL). The file itself is already fsync'd above; the
    // directory sync is a best-effort durability nicety, so skip it on win32.
    if (process.platform !== "win32") {
      const dirHandle = await open(dirPath, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    }
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw err;
  }
};
