/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export {
  AccountError,
  AccountService,
  FileAccountStore,
  InMemoryAccountStore,
  validatePassword,
  validateUsername,
  type AccountErrorCode,
  type AccountServiceOptions,
  type AccountStore,
  type CreateUserInput,
  type FileAccountStoreOptions,
  type PasswordHashRecord,
  type PasswordVerification,
  type RegistryFile,
  type ShadowFile,
  type UserAccount,
} from "./account-service.js";
export {
  DEFAULT_ACCOUNTS_BASE_DIR,
  DEFAULT_USERS_BASE_DIR,
  REGISTRY_FILENAME,
  SHADOW_FILENAME,
  accountsBaseDir,
  homeDirectoryFor,
  registryFilePath,
  shadowFilePath,
  usersBaseDir,
} from "./account-paths.js";
