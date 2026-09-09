export { authenticateRequest } from './authenticator';
export { normalizePlatformRole, permissionsForRole, hasPermission } from './authorization';
export {
  clearScopeCookie,
  clearSessionCookies,
  setScopeCookie,
  setSessionCookies,
} from './cookies';
export { authenticateCredentials } from './login-service';
export {
  hashPassword,
  isBcryptHash,
  passwordExpired,
  passwordMatchesHistory,
  passwordMaxAgeDays,
  validatePasswordPolicy,
  verifyStoredPassword,
} from './password';
export {
  changePasswordAndRevokeSessions,
  findUserByEmail,
  findUserById,
  findUserByUsername,
  listRecentPasswordHashes,
  nextLoginFailureState,
  revokeUserSessions,
  updateOwnProfile,
} from './repository';
export { getJwtSecret, issueSession, verifySessionToken } from './session';
export { issueScopeSession, verifyScopeSession } from './scope-session';
export {
  AUTH_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SCOPE_COOKIE_NAME,
} from './constants';
