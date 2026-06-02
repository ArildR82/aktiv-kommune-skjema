// MIDLERTIDIG hjelpe-endepunkt for å hente Projects v2 felt-ID-er.
// Åpne /api/hent-ider i nettleseren ÉN gang, noter ID-ene, og SLETT så
// denne filen. Den eksponerer ingen hemmeligheter, men bør ikke bli liggende.

export async function onRequestGet(context) {
  const { env } = context;
  const PROJECT_ID = 'PVT_kwDOAhowTc4AUfeE';

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'AktivKommune-Innmelding',
    },
    body: JSON.stringify({
      query: `
        query($id: ID!) {
          node(id: $id) {
            ... on ProjectV2 {
              fields(first: 50) {
                nodes {
                  ... on ProjectV2SingleSelectField {
                    id
                    name
                    options { id name }
                  }
                }
              }
            }
          }
        }
      `,
      variables: { id: PROJECT_ID },
    }),
  });

  const data = await res.json();
  return new Response(JSON.stringify(data, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}
