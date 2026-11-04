/**
 * `@sprigr/apps-home-conformance`: the Home contract's executable checks for
 * an app's Home tool (FINAL-APP-FEEDS section 12). See the README.
 */
export { runHomeConformance, DEFAULT_CONFORMANCE_ACTORS, HOME_MAX_ANSWER_BYTES } from './run';
export type { HomeConformanceActor, HomeConformanceOptions } from './run';
export { formatReport } from './report';
export type { ConformanceCheck, ConformanceReport } from './report';
export { HOME_DISPATCH_READ_METHODS, isD1Like, readOnlySprigr, trackD1 } from './tracking';
export type { D1Tracker, SprigrTracker } from './tracking';
