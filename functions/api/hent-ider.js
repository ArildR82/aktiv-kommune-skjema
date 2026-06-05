// MIDLERTIDIG: henter prosjekt-ID og felt-ID-er for prosjekt 14.
export async function onRequestGet(context) {
  const { env } = context;

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'AktivKommune-Innmelding',
    },
    body: JSON.stringify({
      query: `
        query {
          organization(login: "PorticoEstate") {
            projectV2(number: 14) {
              id
              title
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
    }),
  });

  const data = await res.json();
  return new Response(JSON.stringify(data, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}
