/**
 * Boot the Workers oracle for attach-mode runs (stress-compare): provisions
 * `.dev.vars` (harness + signing key + mock memory engine) and keeps
 * `wrangler dev` running until killed.
 *
 *   pnpm exec tsx test/lib/boot-workers-main.ts [mockPort]
 */
import { ORACLE_DID, provisionDevVars, startOracle } from './oracle';

const mockPort = Number(process.argv[2] ?? 34675);

async function main(): Promise<void> {
  await provisionDevVars({
    signing: true,
    extra: {
      MEMORY_MCP_URL: `http://localhost:${mockPort}/mcp`,
      MEMORY_ENGINE_URL: `http://localhost:${mockPort}`,
    },
  });
  const oracle = await startOracle();
  console.log(`ORACLE_URL=${oracle.url}`);
  console.log(`ORACLE_DID=${ORACLE_DID}`);
  console.log('ready — kill this process to stop wrangler dev');
  const stop = async (): Promise<void> => {
    await oracle.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
