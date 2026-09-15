/**
 * mock-warehouse - the carrier-scan half of the fixture.
 *
 * `provider.shipment.event` is the contract's carrier-scan callback
 * (fulfilment-hub-v1 section 4). It is the one provider event with a closed
 * stage enum, its own dedup key, and no `fulfilment_request_id` of its own:
 * the hub correlates it to a shipment on `provider_shipment_ref`. Everything
 * a scan needs to be deterministic lives here so both levers mint the same
 * shapes and the tests can assert them without a handler round-trip.
 */

/**
 * `shipment_event.stage`, closed. A real adapter maps its carrier's
 * vocabulary onto these six; the mock just takes one.
 */
export const SHIPMENT_STAGES = [
  'label_printed',
  'departed_warehouse',
  'first_scan',
  'destination_arrival',
  'delivered',
  'exception',
] as const;

export type ShipmentStage = (typeof SHIPMENT_STAGES)[number];

/** The scans a real carrier reports between the warehouse door and the doorstep. */
export const DELIVERY_SEQUENCE: readonly ShipmentStage[] = [
  'departed_warehouse',
  'first_scan',
  'destination_arrival',
  'delivered',
];

/** A default location per stage, so a shakedown sees a plausible trail. */
export const STAGE_LOCATION: Record<ShipmentStage, string> = {
  label_printed: 'Mock Warehouse',
  departed_warehouse: 'Mock Warehouse',
  first_scan: 'Carrier origin depot',
  destination_arrival: 'Destination depot',
  delivered: 'Delivery address',
  exception: 'Carrier origin depot',
};

export const DEFAULT_SCAN_STAGE: ShipmentStage = 'departed_warehouse';

/** One scan as it is kept on the request row, in `scans_json`. */
export interface ScanRecord {
  stage: ShipmentStage;
  occurred_at: string;
  provider_event_ref: string;
  location?: string;
  detail?: string;
}

export function isShipmentStage(value: unknown): value is ShipmentStage {
  return typeof value === 'string' && (SHIPMENT_STAGES as readonly string[]).includes(value);
}

/** Tolerant read of the JSON column: a corrupt value is an empty history, never a throw. */
export function parseScans(scansJson: string): ScanRecord[] {
  if (!scansJson) return [];
  try {
    const parsed = JSON.parse(scansJson) as unknown;
    return Array.isArray(parsed) ? (parsed as ScanRecord[]) : [];
  } catch {
    return [];
  }
}

/** The shipment a scan hangs off. Deterministic, and the same ref `ship` emits. */
export function shipmentRefFor(fulfilmentRequestId: string): string {
  return `mws_${fulfilmentRequestId}`;
}

/**
 * `mwe_<fulfilment_request_id>_<stage>_<n>`, where n counts scans of THAT
 * stage already on the row. Deterministic so a shakedown can predict the ref
 * it will assert, and distinct per repeat so a second scan of the same stage
 * is a new event rather than a dedup collision at the hub.
 */
export function eventRefFor(
  fulfilmentRequestId: string,
  stage: ShipmentStage,
  priorScans: readonly ScanRecord[],
): string {
  const n = priorScans.filter((scan) => scan.stage === stage).length + 1;
  return `mwe_${fulfilmentRequestId}_${stage}_${n}`;
}

/**
 * ISO 8601 UTC with a Z suffix (contract clarification 11), shifted by whole
 * seconds. The delivery sequence backdates its first three scans so the four
 * carry distinct, ordered stamps and none of them is in the future.
 */
export function scanStamp(now: string, offsetSeconds = 0): string {
  const ms = Date.parse(now);
  if (!Number.isFinite(ms)) return now;
  return new Date(ms + offsetSeconds * 1000).toISOString();
}
