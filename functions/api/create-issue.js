// Cloudflare Pages Function
// Plassering: functions/api/create-issue.js
// Endepunkt: /api/create-issue

// --- Konfigurasjon ---------------------------------------------------------
const OWNER = 'PorticoEstate';
const REPO = 'PorticoEstate-v2';
const PROJECT_ID = 'PVT_kwDOAhowTc4BKcsn';

const AREA_FIELD_ID = 'PVTSSF_lADOAhowTc4BKcsnzg6cIdg';
const AREA_OPTION_ID = '8aadc6ae';

const BUCKET = 'innsendte-bilder';
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

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

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
const objectPath = `${Date.now()}-${indexForName}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const bytes = base64ToBytes(image.dataBase64);

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
  const fullUrl = `${supabaseUrl}/storage/v1${signData.signedURL}`;

 const altTekst = (image.beskrivelse && image.beskrivelse.trim()) ? image.beskrivelse.trim() : objectPath;
  if (image.beskrivelse && image.beskrivelse.trim()) {
    return `*${image.beskrivelse.trim()}*\n\n![${altTekst}](${fullUrl})`;
  }
  return `![${altTekst}](${fullUrl})`;
}

async function setAreaField(projectItemId, token) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId,
            itemId: $itemId,
            fieldId: $fieldId,
            value: { singleSelectOptionId: $optionId }
          }) {
            projectV2Item { id }
          }
        }
      `,
      variables: {
        projectId: PROJECT_ID,
        itemId: projectItemId,
        fieldId: AREA_FIELD_ID,
        optionId: AREA_OPTION_ID,
      },
    }),
  });
  return res.json();
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

    let assignee = null;
    switch (label) {
      case 'ny funksjon':
        assignee = 'ArildR82';
        break;
      case 'kritisk feil':
        assignee = 'geirsandvoll';
        break;
      case 'feil':
        assignee = 'geirsandvoll';
        break;
      case 'forbedring':
        assignee = 'ArildR82';
        break;
      default:
        assignee = null;
    }

    const issuePayload = {
      title,
      body: fullBody,
      labels: label ? [label] : [],
      ...(assignee && { assignees: [assignee] }),
    };

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

    const projectItemId = projectData.data?.addProjectV2ItemById?.item?.id;
    if (AREA_FIELD_ID && AREA_OPTION_ID && projectItemId) {
      const areaResult = await setAreaField(projectItemId, GITHUB_TOKEN);
      if (areaResult.errors) {
        return json(200, {
          message: `Issue opprettet! Nummer: ${issue.number} (men Område ble ikke satt)`,
          issueNumber: issue.number,
          issueUrl: issue.html_url,
          areaErrors: areaResult.errors,
        });
      }
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
