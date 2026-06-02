// Cloudflare Pages Function
// Plassering: functions/api/create-issue.js
// Endepunkt: /api/create-issue
//
// Bilder lastes opp til en PRIVAT Supabase Storage-bøtte, og funksjonen
// limer en signert (tidsbegrenset) lenke inn i issuet. Bildene er dermed
// ikke offentlig synlige, selv om issuet ligger i et offentlig repo.

// --- Konfigurasjon ---------------------------------------------------------
const OWNER = 'PorticoEstate';
const REPO = 'PorticoEstate-v2'; // mål-repoet der issuene havner
const PROJECT_ID = 'PVT_kwDOAhowTc4AUfeE';
const MILESTONE_NAME = 'Innkommende feil og forslag';

// Supabase Storage
const BUCKET = 'innsendte-bilder';
// Hvor lenge en bildelenke er gyldig: 1 år (i sekunder).
const SIGNED_URL_EXPIRES = 60 * 60 * 24 * 365;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
// ---------------------------------------------------------------------------

function githubHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'AktivKommune-Innmelding',
  };
}

// Gjør om ren base64 til binærdata (Uint8Array) for opplasting.
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Last ett bilde opp til privat Supabase-bøtte og returner en markdown-lenke
// med en signert URL som er gyldig i SIGNED_URL_EXPIRES sekunder.
async function uploadImageToSupabase(image, indexForName, supabaseUrl, serviceKey) {
  if (!image || !image.dataBase64) {
    throw new Error('Bilde mangler innhold.');
  }

  const type = (image.type || '').toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.includes(type)) {
    throw new Error(`Ugyldig bildetype: ${type || 'ukjent'}.`);
  }

  const approxBytes = Math.floor((image.dataBase64.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    throw new Error('Bildet er for stort (maks 5 MB).');
  }

  const ext = type.split('/')[1] || 'png';
  const objectPath = `${Date.now()}-${indexForName}.${ext}`;
  const bytes = base64ToBytes(image.dataBase64);

  // 1) Last opp til privat bøtte
  const uploadRes = await fetch(
    `${supabaseUrl}/storage/v1/object/${BUCKET}/${encodeURIComponent(objectPath)}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': type,
        'x-upsert': 'true',
      },
      body: bytes,
    }
  );

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`Kunne ikke laste opp bilde (HTTP ${uploadRes.status}): ${errText}`);
  }

  // 2) Lag en signert (tidsbegrenset) lenke
  const signRes = await fetch(
    `${supabaseUrl}/storage/v1/object/sign/${BUCKET}/${encodeURIComponent(objectPath)}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: SIGNED_URL_EXPIRES }),
    }
  );

  if (!signRes.ok) {
    const errText = await signRes.text();
    throw new Error(`Kunne ikke lage bildelenke (HTTP ${signRes.status}): ${errText}`);
  }

  const signData = await signRes.json();
  // signData.signedURL er en relativ sti; sett sammen full URL.
  const fullUrl = `${supabaseUrl}/storage/v1${signData.signedURL}`;

  return `![${objectPath}](${fullUrl})`;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const RECAPTCHA_SECRET = env.RECAPTCHA_SECRET_KEY;
  const GITHUB_TOKEN = env.GITHUB_TOKEN;
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY;

  const json = (statusCode, obj) =>
    new Response(JSON.stringify(obj), {
      status: statusCode,
      headers: { 'Content-Type': 'application/json' },
    });

  let parsed;
  try {
    parsed = await request.json();
  } catch (e) {
    return json(400, { message: 'Ugyldig forespørsel (kunne ikke lese data).' });
  }

  const { title, body, label, recaptcha, images } = parsed;

  // 1) Valider reCAPTCHA
  const captchaRes = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `secret=${RECAPTCHA_SECRET}&response=${encodeURIComponent(recaptcha)}`,
  });

  const captchaData = await captchaRes.json();

  if (!captchaData.success) {
    return json(403, { message: 'reCAPTCHA-validering feilet. Innsending avvist.' });
  }

  try {
    // 2) Hent milestone (fra mål-repoet)
    const milestoneRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/milestones`,
      { headers: githubHeaders(GITHUB_TOKEN) }
    );

    if (!milestoneRes.ok) {
      return json(milestoneRes.status, {
        message: 'Kunne ikke hente milestones.',
        error: await milestoneRes.text(),
      });
    }

    const milestones = await milestoneRes.json();
    const milestone = milestones.find((m) => m.title === MILESTONE_NAME);

    if (!milestone) {
      return json(404, {
        message: `Milestone "${MILESTONE_NAME}" ikke funnet i repoet ${REPO}. Opprett den i mål-repoet.`,
      });
    }

    // 3) Last opp eventuelle bilder til Supabase (privat) og bygg markdown
    let imageMarkdown = '';
    if (Array.isArray(images) && images.length > 0) {
      if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return json(500, {
          message: 'Bildelagring er ikke konfigurert (mangler Supabase-miljøvariabler).',
        });
      }
      const uploaded = [];
      for (let i = 0; i < images.length; i++) {
        const md = await uploadImageToSupabase(images[i], i, SUPABASE_URL, SUPABASE_SERVICE_KEY);
        uploaded.push(md);
      }
      imageMarkdown =
        `\n\n---\n\n**Vedlagte bilder:**\n\n` +
        `_Lenkene er tidsbegrensede og synlige kun for den som har dem._\n\n` +
        uploaded.join('\n\n');
    }

    const fullBody = `${body || ''}${imageMarkdown}`;

    // 4) Tildel assignee basert på valgt kategori (label)
    let assignee = null;
    switch (label) {
      case 'Ny funksjonalitet':
        assignee = 'ArildR82';
        break;
      case 'Kritisk feil':
        assignee = 'geirsandvoll';
        break;
      case 'Feil':
        assignee = 'geirsandvoll';
        break;
      case 'Forbedringsønske':
        assignee = 'ArildR82';
        break;
      default:
        assignee = null;
    }

    // 5) Bygg issuePayload
    const issuePayload = {
      title,
      body: fullBody,
      labels: label ? [label] : [],
      milestone: milestone.number,
      ...(assignee && { assignees: [assignee] }),
    };

    // 6) Opprett issue (i mål-repoet)
    const issueRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/issues`,
      {
        method: 'POST',
        headers: { ...githubHeaders(GITHUB_TOKEN), 'Content-Type': 'application/json' },
        body: JSON.stringify(issuePayload),
      }
    );

    const issue = await issueRes.json();

    if (!issueRes.ok || !issue.number) {
      return json(issueRes.status || 500, {
        message: 'Feil ved oppretting av issue.',
        error: issue,
      });
    }

    // 7) Legg til i GitHub Project (Projects v2)
    const projectRes = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { ...githubHeaders(GITHUB_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `
          mutation($projectId: ID!, $contentId: ID!) {
            addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
              item { id }
            }
          }
        `,
        variables: {
          projectId: PROJECT_ID,
          contentId: issue.node_id,
        },
      }),
    });

    const projectData = await projectRes.json();

    if (projectData.errors) {
      return json(500, {
        message: 'Issue ble opprettet, men kunne ikke legges til i prosjekt.',
        errors: projectData.errors,
      });
    }

    return json(200, {
      message: `Issue opprettet! Nummer: ${issue.number}`,
      issueNumber: issue.number,
      issueUrl: issue.html_url,
    });
  } catch (error) {
    return json(500, { message: 'Uventet serverfeil.', error: error.message });
  }
}
