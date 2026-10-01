import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UcanService } from '../../modules/ucan/ucan.service.js';
import { WorkClaimService } from './work-claim.service.js';

/**
 * Hands the delivery lane the oracle's decrypted claim-signing mnemonic —
 * the same key boot already pulled out of the oracle's Matrix account room,
 * used to sign the work claim's VC and the claim-bot UCAN invocations. Read
 * through a provider rather than captured once, because boot loads it
 * asynchronously after the module graph is built.
 */
@Injectable()
export class WorkClaimWiring implements OnModuleInit {
  constructor(
    private readonly ucan: UcanService,
    private readonly workClaim: WorkClaimService,
  ) {}

  onModuleInit(): void {
    this.workClaim.setSigningMnemonicProvider(() =>
      this.ucan.getSigningMnemonic(),
    );
  }
}
