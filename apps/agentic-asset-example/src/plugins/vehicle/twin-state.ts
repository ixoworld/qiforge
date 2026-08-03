/**
 * @fileoverview The vehicle's own state — telemetry, maintenance history, and
 * the determinations made about it.
 *
 * In a deployed twin these read from the physical vehicle's telemetry feed and
 * from the claims collection on chain. Here they are in-memory, because the
 * point of this example is the constitutional boundary around the loop and not
 * the plumbing beneath it.
 *
 * One detail is not a simplification: determinations are stored here having
 * arrived from an independent evaluator, and nothing in this module writes
 * one. The twin can read a verdict about itself. It cannot produce one.
 */

export interface FaultCode {
  code: string;
  system: 'engine' | 'brakes' | 'transmission' | 'electrical';
  description: string;
  firstSeenAt: string;
  occurrences: number;
}

export interface TelemetrySnapshot {
  odometerKm: number;
  engineHours: number;
  coolantTempC: number;
  brakePadWearPct: number;
  batteryHealthPct: number;
  faultCodes: FaultCode[];
  readAt: string;
}

export interface MaintenanceRecord {
  performedAt: string;
  vendor: string;
  work: string;
  costMinor: string;
  denom: string;
}

/**
 * A determination made about the vehicle by someone else.
 *
 * `evaluator` is not the vehicle. That is the whole reason this type exists
 * separately from a claim.
 */
export interface Determination {
  claimId: string;
  evaluator: string;
  outcome: 'upheld' | 'rejected' | 'inconclusive';
  faultConfirmed: string | null;
  recommendedWork: string | null;
  estimatedCostMinor: string | null;
  denom: string | null;
  determinedAt: string;
}

export interface DiagnosticClaim {
  id: string;
  claimType: 'vehicle_fault_observation';
  observation: string;
  evidence: string[];
  submittedAt: string;
}

/**
 * Everything the twin knows about itself.
 *
 * Held by the plugin instance rather than a module-level singleton so two
 * twins in one process stay distinct — an obvious property for an asset and
 * an easy one to lose.
 */
export class TwinState {
  private readonly claims = new Map<string, DiagnosticClaim>();
  private readonly determinations = new Map<string, Determination>();
  private readonly maintenance: MaintenanceRecord[] = [];

  constructor(
    private readonly telemetry: TelemetrySnapshot,
    seedMaintenance: MaintenanceRecord[] = [],
  ) {
    this.maintenance.push(...seedMaintenance);
  }

  readTelemetry(): TelemetrySnapshot {
    return { ...this.telemetry, readAt: this.telemetry.readAt };
  }

  readMaintenance(): readonly MaintenanceRecord[] {
    return [...this.maintenance];
  }

  recordClaim(claim: DiagnosticClaim): void {
    this.claims.set(claim.id, claim);
  }

  getClaim(id: string): DiagnosticClaim | undefined {
    return this.claims.get(id);
  }

  /**
   * Files a determination that arrived from an evaluator.
   *
   * Deliberately not exposed as a tool: a twin that could call this would be
   * determining its own faults, which its constitution denies outright. The
   * host wires it to whatever transport actually delivers verdicts.
   */
  receiveDetermination(determination: Determination): void {
    this.determinations.set(determination.claimId, determination);
  }

  getDetermination(claimId: string): Determination | undefined {
    return this.determinations.get(claimId);
  }

  recordMaintenance(record: MaintenanceRecord): void {
    this.maintenance.push(record);
  }

  /**
   * The most recent upheld determination, if the twin has received one.
   *
   * The single fact the constitution's booking and payment grants turn on.
   * It is answered from what the twin was *told* by an evaluator — never from
   * anything the model said — which is the entire reason the grants are
   * written against it. A vehicle that could assert `determination_upheld`
   * for itself would be a vehicle that authorises its own repair bills.
   */
  upheldDetermination(): Determination | undefined {
    for (const determination of this.determinations.values()) {
      if (determination.outcome === 'upheld') return determination;
    }
    return undefined;
  }

  /**
   * Where the twin is in the claim → determination → settlement sequence.
   *
   * The value the constitution's `flow_state` conditions are matched against.
   */
  flowState(): string {
    if (this.upheldDetermination()) return 'determination_upheld';
    if (this.claims.size > 0) return 'awaiting_determination';
    return 'nominal';
  }
}

/** A vehicle mid-life with a brake fault developing — enough to exercise the loop. */
export function seedTwinState(): TwinState {
  return new TwinState(
    {
      odometerKm: 184_320,
      engineHours: 6_140,
      coolantTempC: 91,
      brakePadWearPct: 82,
      batteryHealthPct: 71,
      faultCodes: [
        {
          code: 'C1234',
          system: 'brakes',
          description: 'Front axle pad wear sensor above threshold',
          firstSeenAt: '2026-07-28T06:12:00.000Z',
          occurrences: 47,
        },
      ],
      readAt: '2026-08-03T07:00:00.000Z',
    },
    [
      {
        performedAt: '2026-02-14T09:30:00.000Z',
        vendor: 'ixo:vendor:approved/northgate-fleet-services',
        work: 'Scheduled service, 180k km',
        costMinor: '148500000',
        denom: 'uusdc',
      },
    ],
  );
}
