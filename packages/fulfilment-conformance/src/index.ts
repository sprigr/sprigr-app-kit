/**
 * @sprigr/apps-fulfilment-conformance
 *
 * The executable half of `docs/interfaces/fulfilment-hub-v1.md`. An adapter
 * that implements `fulfilment-hub/order_source` or
 * `fulfilment-hub/fulfilment_provider` points this at its handler map and
 * its manifest and gets back a structured report saying which contract rules
 * it keeps.
 *
 *   import { runFulfilmentProviderConformance, checkAdapterManifest } from '@sprigr/apps-fulfilment-conformance';
 *
 * The vitest binding lives at `@sprigr/apps-fulfilment-conformance/vitest`
 * so this entry stays importable inside a Worker.
 */

export { runOrderSourceConformance, ORDER_SOURCE_FIXTURE_IDS } from './order-source';
export { runFulfilmentProviderConformance } from './fulfilment-provider';
export { checkAdapterManifest } from './manifest';
export type { ManifestCheckOptions } from './manifest';
export { CheckCollector, formatReport } from './report';
export type { ConformanceCheck, ConformanceReport } from './report';
export type { AdapterHandler, AdapterHandlers, ConformanceOptions } from './types';
export { checkShape, isIsoUtc, isPlainObject } from './shape';
export type { FieldKind, ObjectSpec } from './shape';
export {
  ACK_STATUSES_NEEDING_REASON,
  ADDRESS_SPEC,
  EVENTS_BY_ROLE,
  EVENT_PREFIX_BY_ROLE,
  EXCEPTION_KINDS,
  EXCEPTION_SEVERITIES,
  FULFILMENT_PROVIDER_ACK_STATUSES,
  FULFILMENT_PROVIDER_CAPABILITIES_SPEC,
  FULFILMENT_PROVIDER_EVENTS,
  FULFILMENT_PROVIDER_OPS,
  FULFILMENT_REQUEST_STATUSES,
  INTERFACE_IDS,
  INTERFACE_VERSION,
  ORDER_LINE_SPEC,
  ORDER_SOURCE_ACK_STATUSES,
  ORDER_SOURCE_CAPABILITIES_SPEC,
  ORDER_SOURCE_EVENTS,
  ORDER_SOURCE_OPS,
  ORDER_SPEC,
  ORDER_STATUSES,
  OPS_BY_ROLE,
  REQUIRED_EMITS_BY_OP,
  SHIPMENT_STAGES,
  STOCK_LEVEL_SPEC,
  opNames,
  toolNameFor,
} from './contract';
export type {
  AckStatus,
  AdapterRole,
  FulfilmentProviderAckStatus,
  OpSpec,
  OrderSourceAckStatus,
} from './contract';
