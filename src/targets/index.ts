export type { GitCommitResult } from "../core/state/report.js";
export {
  type FilesystemTargetOptions,
  sanitizeSegment,
  type WriteResult,
  writeWorkspace,
} from "./filesystem.js";
export type { GitLogEntry, GitSyncOptions } from "./git.js";
export { ensureGitignore, GITIGNORE_ENTRIES, GitError, gitLog, gitSync } from "./git.js";
export {
  createS3Target,
  type S3SyncError,
  type S3SyncResult,
  S3Target,
  type S3TargetOptions,
  syncDirectoryToS3,
} from "./s3.js";
export type { SyncTarget } from "./target.js";
