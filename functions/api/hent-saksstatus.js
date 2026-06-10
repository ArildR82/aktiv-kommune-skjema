// MIDLERTIDIG: henter felt-ID og option-ID-er for "Saksstatus".
// Åpne /api/hent-saksstatus i nettleseren ÉN gang, noter ID-ene, og SLETT så filen.

export async function onRequestGet(context) {
  const { env } = context;
  const PROJECT_ID = 'PVT_kwDOAhowTc4BKcsn';

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
              field(name: "Saksstatus") {
                ... on ProjectV2SingleSelectField {
                  id
                  options { id name }
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
