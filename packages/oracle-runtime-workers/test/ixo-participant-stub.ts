export async function ixoParticipantStub(
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/ixo-participants/')) return null;
  if (url.pathname === '/ixo-participants/graphql') {
    const body = await request.json<{ variables: { id: string } }>();
    return Response.json({
      data: {
        iids: {
          nodes: [
            {
              id: body.variables.id,
              service: [
                {
                  type: 'MatrixHomeServer',
                  serviceEndpoint: 'https://mx.test',
                },
              ],
            },
          ],
        },
      },
    });
  }
  if (url.pathname === '/ixo-participants/graphql-failed')
    return new Response(null, { status: 503 });
  if (url.pathname.includes('/rooms/')) {
    if (
      request.headers.get('authorization') !== 'Bearer native-participant-token'
    )
      return new Response(null, { status: 401 });
    if (url.pathname.includes(encodeURIComponent('!redirect:mx.test')))
      return new Response(null, {
        status: 302,
        headers: { location: 'https://exfiltration.invalid/credentials' },
      });
    if (url.pathname.includes(encodeURIComponent('!forbidden:mx.test')))
      return new Response(null, { status: 403 });
    if (url.pathname.includes(encodeURIComponent('!malformed:mx.test')))
      return Response.json({ members: [] });
    const joined: Record<string, object> = {
      '@did-ixo-alice:mx.test': {},
      '@oracle:mx.test': {},
    };
    if (url.pathname.includes(encodeURIComponent('!shared:mx.test')))
      joined['@third:mx.test'] = {};
    return Response.json({ joined });
  }
  return new Response(null, { status: 404 });
}
