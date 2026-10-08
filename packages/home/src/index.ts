/**
 * Home Contracts (FINAL-APP-FEEDS; decisions "Home contracts" and "The
 * audience sets the actor"): the five platform-owned contracts apps answer to
 * feed the Sprigr Home, their record kinds and versioning, the manifest
 * `home` block and its validator, the fixture check, and the curated
 * `sprigr/` definitions seed.
 *
 * Published as `@sprigr/apps-home`. Every file except this index and
 * display.ts is a verbatim copy of sprigr-team
 * `packages/shared/src/home-contracts/` (see the README for the source
 * commit), so the platform and the apps validate with the same code. The
 * schema builders (`req`, `opt`, `str`, ...) stay internal.
 */

export * from './vocabulary';
export type {
  DetailField,
  HomeBlock,
  HomeEnvelope,
  HomeFixtureCase,
  HomeIdentityDeclaration,
  HomeLinkDeclaration,
  HomeProviderDeclaration,
  HomeRateDeclaration,
  HomeRecordByContract,
  HomeRequest,
  HomeResult,
  IdentityPerson,
  IdentityRecord,
  Instant,
  LocalDay,
  MetricPeriod,
  MetricRecord,
  MetricValue,
  Money,
  QueueRecord,
  Ref,
  ScheduleRecord,
  Subject,
  SubjectFactRecord,
} from './types';
export {
  checkHomeValue,
  flattenHomeFields,
  forEachHomeDisplayString,
  homeJsonSchema,
  homeValueProblems,
  isHomeAbn,
  isHomeEmail,
  isHomeInstant,
  isHomeLocalDay,
  isHomeTimeZone,
  isPlainHomeObject,
} from './schema';
export type { HomeFieldEntry, HomeFieldSpec, HomeFlatField, HomeObjectFields, HomeStringFormat } from './schema';
export {
  HOME_DETAIL_SPEC,
  HOME_IDENTITY_RECORD_FIELDS,
  HOME_METRIC_RECORD_FIELDS,
  HOME_MONEY_SPEC,
  HOME_QUEUE_RECORD_FIELDS,
  HOME_RECORD_FIELDS,
  HOME_RECORD_NAMES,
  HOME_REF_SPEC,
  HOME_REQUEST_FIELDS,
  HOME_SCHEDULE_RECORD_FIELDS,
  HOME_SUBJECT_FACT_RECORD_FIELDS,
  HOME_SUBJECT_SPEC,
  checkHomeAnswer,
  homeRecordCap,
  homeRecordProblems,
  homeRequestProblems,
  homeResultFields,
} from './records';
export type { HomeAnswerCheck, HomeAnswerContext, HomeRecordContext } from './records';
export {
  homeBlockFromManifest,
  homeDeclarationKey,
  homeFixturePaths,
  homeNamespaceProblem,
  homeProviderCatalogueRows,
  homeToolNameFor,
  validateHome,
} from './manifest';
export type { HomeManifestLike, HomeProviderCatalogueRow, HomeValidationDeps } from './manifest';
export { HOME_FIXTURE_MAX_CASES, homeDisplayTextProblem, requiredFixtureStates, validateHomeFixtures } from './fixtures';
export { HOME_CONTRACT_OP, homeContractDefinitions } from './definitions';
export type { HomeContractDefinition } from './definitions';
export {
  HOME_INVALIDATE_BODY_KEYS,
  HOME_INVALIDATE_MAX_BODY_CHARS,
  HOME_INVALIDATE_OWNER_MAX_CHARS,
  HOME_INVALIDATE_PATH,
  homeInvalidateBodyFor,
  homeInvalidateBodyProblems,
} from './invalidate';
export type { HomeInvalidateBody, HomeInvalidateInput, HomeInvalidateResult } from './invalidate';
export { homeDisplayText } from './display';
