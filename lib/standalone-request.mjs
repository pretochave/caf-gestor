/** The standalone origin never accepts identities injected by a former hosting proxy. */
export function independentRequest(request) {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith("oai-authenticated-user-")) headers.delete(name);
  }
  return new Request(request, { headers });
}
