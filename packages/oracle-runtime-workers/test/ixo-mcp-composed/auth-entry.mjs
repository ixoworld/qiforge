import app from '@stage7-auth/src/index';
import { signAccessToken } from '@stage7-auth/src/lib/oauth/jwt';
import {
  getGrant,
  insertClient,
  upsertGrant,
} from '@stage7-auth/src/lib/oauth/store';
import { hashToken } from '@stage7-auth/src/lib/oauth/tokens';

const RESOURCE = 'https://oracle.example/v1/mcp';
export default {
  async fetch(request, env, ctx) {
    const path = new globalThis.URL(request.url).pathname;
    if (!path.startsWith('/__fixture/')) return app.fetch(request, env, ctx);
    if (
      env.LOCAL_STAGE7_PROOF !== 'yes' ||
      request.headers.get('x-local-proof') !== env.LOCAL_FIXTURE_SECRET
    )
      return new globalThis.Response(null, { status: 404 });
    const body = await request.json();
    if (path === '/__fixture/seed') {
      await env.DB.prepare(
        "INSERT INTO users (id,workos_user_id_hash,address,did,registration_status) VALUES ('user-alice','test-only-hash','alice','did:ixo:alice','complete')",
      ).run();
      for (const clientId of [
        'client-1',
        'client-2',
        'client-shared',
        'client-unregistered',
      ]) {
        await insertClient(env.DB, {
          client_id: clientId,
          client_secret_hash: null,
          client_name: clientId,
          redirect_uris: ['https://app.example/callback'],
          token_endpoint_auth_method: 'none',
          verified: true,
        });
      }
      await insertClient(env.DB, {
        client_id: 'resource-1',
        client_secret_hash: hashToken('local-resource-secret'),
        client_name: 'Local resource',
        redirect_uris: ['https://oracle.example/callback'],
        token_endpoint_auth_method: 'client_secret_basic',
        verified: false,
      });
      await env.DB.prepare(
        'INSERT INTO oauth_resources (resource,resource_client_id,enabled) VALUES (?, ?,1)',
      )
        .bind(RESOURCE, 'resource-1')
        .run();
      for (const client of ['client-1', 'client-2', 'client-shared'])
        await env.DB.prepare(
          'INSERT INTO oauth_resource_clients (resource,client_id,enabled) VALUES (?, ?,1)',
        )
          .bind(RESOURCE, client)
          .run();
      return globalThis.Response.json({ seeded: true });
    }
    if (path === '/__fixture/token') {
      const client = body.client ?? 'client-1';
      const gid = await upsertGrant(env.DB, {
        userId: 'user-alice',
        did: 'did:ixo:alice',
        clientId: client,
        resource: RESOURCE,
        scope: 'ixo:tools:read',
      });
      const grant = await getGrant(env.DB, gid);
      const token = await signAccessToken(env, {
        sub: grant.did,
        aud: grant.resource,
        clientId: grant.client_id,
        clientName: client,
        verified: true,
        gid,
        generation: grant.generation,
        scope: grant.scope,
      });
      return globalThis.Response.json({
        token,
        gid,
        generation: grant.generation,
      });
    }
    if (path === '/__fixture/state') {
      const client = body.client ?? 'client-1';
      const queries = {
        revoke: [
          "UPDATE oauth_grants SET status='revoked' WHERE client_id=?",
          client,
        ],
        block: [
          'UPDATE oauth_clients SET blocked_at=1 WHERE client_id=?',
          client,
        ],
        unblock: [
          'UPDATE oauth_clients SET blocked_at=NULL WHERE client_id=?',
          client,
        ],
        disableJoin: [
          'UPDATE oauth_resource_clients SET enabled=0 WHERE client_id=?',
          client,
        ],
        enableJoin: [
          'UPDATE oauth_resource_clients SET enabled=1 WHERE client_id=?',
          client,
        ],
        failUser: [
          "UPDATE users SET registration_status='failed' WHERE id=?",
          'user-alice',
        ],
        restoreUser: [
          "UPDATE users SET registration_status='complete' WHERE id=?",
          'user-alice',
        ],
        disableResource: [
          'UPDATE oauth_resources SET enabled=0 WHERE resource=?',
          RESOURCE,
        ],
        enableResource: [
          'UPDATE oauth_resources SET enabled=1 WHERE resource=?',
          RESOURCE,
        ],
      };
      const query = queries[body.action];
      if (!query)
        return globalThis.Response.json(
          { error: 'unknown_fixture_action' },
          { status: 400 },
        );
      await env.DB.prepare(query[0]).bind(query[1]).run();
      return globalThis.Response.json({ changed: true });
    }
    return new globalThis.Response(null, { status: 404 });
  },
};
