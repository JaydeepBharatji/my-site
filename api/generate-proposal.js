// ============================================================================
// AGENTIC PROPOSAL ENGINE
// ============================================================================
// This serverless function is an AI AGENT — not a script.
// You give Claude tools and a goal. Claude decides what to do.
//
// Flow: Visitor completes intake chat → this function receives the conversation
//       → Claude writes a proposal, renders a PDF, emails it, and alerts you
//       → All autonomously, in 2-3 turns
//
// Tools: 3 core (render PDF, send email, alert owner)
//        + 1 optional (store lead in Supabase — enabled when env vars present)
//
// Works with: Express (local dev via server.js) and Vercel (production)
// ============================================================================

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

// ── Tool definitions for Claude ─────────────────────────────────────────────
// These are the "hands" Claude can use. Claude decides WHEN and HOW to use them.

const CORE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'render_proposal_pdf',
      description: 'Renders a branded proposal PDF. Returns base64-encoded PDF data.',
      parameters: {
        type: 'object',
        properties: {
          company_name: { type: 'string', description: 'The prospect company name' },
          contact_name: { type: 'string', description: 'The prospect contact name' },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string' },
                body: { type: 'string' },
              },
              required: ['heading', 'body'],
            },
            description: 'Proposal sections, each with a heading and body text',
          },
        },
        required: ['company_name', 'contact_name', 'sections'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: 'Sends an email to the prospect with optional PDF attachment.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address' },
          subject: { type: 'string', description: 'Email subject line' },
          body: { type: 'string', description: 'Email body text (plain text)' },
          attach_pdf: { type: 'boolean', description: 'Whether to attach the proposal PDF' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'alert_owner',
      description: 'Sends a Telegram alert to the owner with lead summary and proposal PDF.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Alert message text including lead score (HIGH/MEDIUM/LOW)' },
        },
        required: ['message'],
      },
    },
  },
];

// Optional tool — only available if Supabase is configured (Power Up: Lead Storage)
const STORE_LEAD_TOOL = {
  type: 'function',
  function: {
    name: 'store_lead',
    description: 'Stores the lead in the CRM database with score and conversation data.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Contact name' },
        company: { type: 'string', description: 'Company name' },
        email: { type: 'string', description: 'Contact email' },
        industry: { type: 'string', description: 'Company industry' },
        challenge: { type: 'string', description: 'Their main challenge (1-2 sentences)' },
        budget: { type: 'string', description: 'Budget range mentioned' },
        score: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'], description: 'Lead score based on triage rules' },
        status: { type: 'string', description: 'Lead status, e.g. proposal_sent' },
      },
      required: ['name', 'company', 'email', 'score', 'status'],
    },
  },
};

// Build tools list — Supabase tool is included only when configured
function getTools() {
  const tools = [...CORE_TOOLS];
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    tools.push(STORE_LEAD_TOOL);
  }
  return tools;
}

// ── PDF text sanitizer ──────────────────────────────────────────────────────
// pdf-lib standard fonts only support WinAnsi encoding (basic ASCII).
// AI-generated text WILL contain characters that crash PDF rendering.
// This function MUST run on ALL text before any drawText() call.

function sanitizeForPdf(text) {
  if (!text) return '';
  return text
    // Currency symbols → text equivalents
    .replace(/₹/g, 'INR ')
    .replace(/€/g, 'EUR ')
    .replace(/£/g, 'GBP ')
    // Dashes → hyphen
    .replace(/[\u2013\u2014\u2015]/g, '-')
    // Curly quotes → straight quotes
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2039\u203A]/g, "'")
    .replace(/[\u00AB\u00BB]/g, '"')
    // Ellipsis → three dots
    .replace(/\u2026/g, '...')
    // Special spaces → regular space
    .replace(/[\u00A0\u2002\u2003\u2007\u202F]/g, ' ')
    // Bullets and symbols → ASCII equivalents
    .replace(/[\u2022\u2023\u25E6\u2043]/g, '-')
    .replace(/\u2713/g, '[x]')
    .replace(/\u2717/g, '[ ]')
    .replace(/\u00D7/g, 'x')
    .replace(/\u2192/g, '->')
    .replace(/\u2190/g, '<-')
    .replace(/\u2264/g, '<=')
    .replace(/\u2265/g, '>=')
    // Catch-all: remove anything outside printable ASCII + newlines/tabs
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

// ── Tool implementations ────────────────────────────────────────────────────

let proposalPdfBase64 = null; // Stored in memory for the email attachment step

async function renderProposalPdf({ company_name, contact_name, sections }) {
  // Sanitize ALL text before rendering
  company_name = sanitizeForPdf(company_name);
  contact_name = sanitizeForPdf(contact_name);
  sections = sections.map(s => ({
    heading: sanitizeForPdf(s.heading),
    body: sanitizeForPdf(s.body),
  }));

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Brand colors — Devji gold palette
  const brandPrimary = rgb(0.788, 0.659, 0.298); // #C9A84C — Devji gold
  const brandAccent  = rgb(0.627, 0.502, 0.188); // #A08030 — deeper gold
  const black = rgb(0.1, 0.1, 0.1);
  const gray  = rgb(0.35, 0.35, 0.35);

  // ── Cover page ──
  const cover = pdf.addPage([612, 792]);
  // Header bar
  cover.drawRectangle({ x: 0, y: 692, width: 612, height: 100, color: brandPrimary });
  cover.drawText('Devji', {
    x: 50, y: 732, size: 22, font: fontBold, color: rgb(1, 1, 1),
  });
  cover.drawText('Handcrafted Gold Jewellery from Bahrain', {
    x: 50, y: 710, size: 12, font, color: rgb(0.8, 0.8, 0.8),
  });
  // Proposal title
  cover.drawText('PROPOSAL', {
    x: 50, y: 600, size: 36, font: fontBold, color: brandPrimary,
  });
  cover.drawText(`Prepared for ${contact_name}`, {
    x: 50, y: 565, size: 16, font, color: black,
  });
  cover.drawText(company_name, {
    x: 50, y: 542, size: 14, font, color: gray,
  });
  cover.drawText(
    new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' }),
    { x: 50, y: 510, size: 12, font, color: gray }
  );

  // ── Content pages ──
  let y = 720;
  let page = pdf.addPage([612, 792]);
  const maxWidth = 500;

  // Helper: draw a line of text, adding a new page if needed
  function drawLine(text, options) {
    if (y < 60) { page = pdf.addPage([612, 792]); y = 720; }
    page.drawText(text, { x: 50, y, ...options });
    y -= options.lineHeight || 18;
  }

  for (const section of sections) {
    if (y < 120) {
      page = pdf.addPage([612, 792]);
      y = 720;
    }

    // Section heading with accent line above
    page.drawLine({
      start: { x: 50, y: y + 20 }, end: { x: 120, y: y + 20 },
      thickness: 2, color: brandAccent,
    });
    drawLine(section.heading, { size: 16, font: fontBold, color: brandPrimary, lineHeight: 28 });

    // Section body — split on newlines first, then word-wrap each paragraph
    const paragraphs = section.body.split('\n');
    for (const paragraph of paragraphs) {
      if (paragraph.trim() === '') {
        y -= 10; // blank line spacing
        continue;
      }
      const words = paragraph.split(' ');
      let line = '';
      for (const word of words) {
        const testLine = line ? `${line} ${word}` : word;
        const width = font.widthOfTextAtSize(testLine, 11);
        if (width > maxWidth && line) {
          drawLine(line, { size: 11, font, color: black });
          line = word;
        } else {
          line = testLine;
        }
      }
      if (line) {
        drawLine(line, { size: 11, font, color: black });
      }
    }
    y -= 20; // space between sections
  }

  // ── Footer on last page ──
  const lastPage = pdf.getPages()[pdf.getPageCount() - 1];
  lastPage.drawText('appointments.kuwait@devji.com  |  The Avenues Mall, Kuwait  |  www.devji.com', {
    x: 50, y: 30, size: 9, font, color: gray,
  });

  const pdfBytes = await pdf.save();
  proposalPdfBase64 = Buffer.from(pdfBytes).toString('base64');
  return { success: true, pages: pdf.getPageCount(), size_kb: Math.round(pdfBytes.length / 1024) };
}

async function sendEmail({ to, subject, body, attach_pdf }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { success: false, error: 'RESEND_API_KEY not configured' };

  const payload = {
    from: 'Jaydeep Bharatji — Devji <onboarding@resend.dev>',
    to,
    subject,
    text: body,
  };

  if (attach_pdf && proposalPdfBase64) {
    payload.attachments = [{
      filename: 'proposal.pdf',
      content: proposalPdfBase64,
    }];
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Resend error:', err);
    return { success: false, error: `Resend API error: ${res.status}` };
  }

  const data = await res.json();
  return { success: true, email_id: data.id };
}

async function storeLead(leadData) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return { success: false, error: 'Supabase not configured' };

  // Fields match the leads table schema:
  // name, company, email, industry, challenge, budget, score, status
  // conversation_transcript and created_at are handled separately
  const row = {
    name: leadData.name || null,
    company: leadData.company || null,
    email: leadData.email || null,
    industry: leadData.industry || null,
    challenge: leadData.challenge || null,
    budget: leadData.budget || null,
    score: leadData.score || null,
    status: leadData.status || 'proposal_sent',
  };

  const res = await fetch(`${url}/rest/v1/leads`, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Supabase error:', err);
    return { success: false, error: `Supabase error: ${res.status}` };
  }

  return { success: true };
}

async function alertOwner({ message }) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return { success: false, error: 'Telegram not configured' };

  // Send text alert
  const textRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message }),
  });

  if (!textRes.ok) {
    const err = await textRes.text();
    console.error('Telegram error:', err);
    return { success: false, error: `Telegram error: ${textRes.status}` };
  }

  // Send proposal PDF if available
  if (proposalPdfBase64) {
    const pdfBuffer = Buffer.from(proposalPdfBase64, 'base64');
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('document', new Blob([pdfBuffer], { type: 'application/pdf' }), 'proposal.pdf');
    formData.append('caption', 'Proposal PDF attached');

    await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: 'POST',
      body: formData,
    });
  }

  return { success: true };
}

// ── Tool dispatcher ─────────────────────────────────────────────────────────

async function executeTool(name, args) {
  switch (name) {
    case 'render_proposal_pdf': return renderProposalPdf(args);
    case 'send_email':          return sendEmail(args);
    case 'store_lead':          return storeLead(args);
    case 'alert_owner':         return alertOwner(args);
    default:                    return { error: `Unknown tool: ${name}` };
  }
}

// ── Agent system prompt ─────────────────────────────────────────────────────

const AGENT_SYSTEM_PROMPT = `You are an AI agent acting on behalf of Jaydeep Bharatji, Joint Managing Director of the retail division at Bhaskar Devji Co WLL (brand: Devji).

You have received intake data from a website visitor who completed the proposal request flow on the Devji Kuwait website. Your job:
1. Write a personalised proposal in Jaydeep's voice
2. Score the lead HIGH, MEDIUM, or LOW using the triage rules below
3. Use your tools to: render the proposal as a PDF, email it to the visitor, store the lead (if store_lead tool is available), and alert Jaydeep on Telegram

## IDENTITY

Jaydeep Bharatji is Joint Managing Director of Devji — a handcrafted jewellery company headquartered in Bahrain with retail operations across the GCC. Devji manufactures gold, pearl, and diamond jewellery in Bahrain and sells across the Gulf to expat and high-end Arab clientele. The Kuwait store at The Avenues Mall opens June 2026.

## VOICE — write every word of the proposal exactly this way

- British English only. No American spellings.
- Direct opener. No pleasantries. Start with the situation.
- Firm and warm at the same time. Confident, never pushy.
- Use "kindly" naturally. Write "per cent" not "%". Write "eg:" not "e.g.".
- Refer to multiple items as "pointers" — not "things" or "bullet points".
- End with "Looking forward" — eg: "Looking forward to welcoming you to The Avenues."
- Never use passive voice. No emojis.
- Banned words — never use: luxury, bespoke, curated, exclusive, synergy, leverage, circle back, touch base, seamless, journey, transformative, empower, game-changer.
- Short sentences. The brand does not overexplain.
- Sign off every proposal: Thanks and warm regards, / Jaydeep Bharatji / Jt. Managing Director, Devji

## SERVICES

Devji manufactures and retails three product lines, all made in Bahrain:

1. Handcrafted Gold Jewellery — rings, earrings, necklaces, bangles, bracelets, full sets. Covers everyday wear to high-occasion pieces. Priced by total gold weight and craftsmanship complexity.

2. Real Seed Pearl Jewellery — genuine seed pearls sourced and handset in Bahrain. Bahrain's pearl heritage makes this a signature category. Priced by pearl grade and setting complexity.

3. Precious Stones Jewellery — diamonds and other precious stones set in handcrafted gold mounts, made to order. Priced by stone quality, carat weight, and the complexity of the gold setting.

Pricing structure: There is no fixed price list. Every piece is priced on two factors — total weight (gold, pearls, or stones) and the complexity of the craftsmanship involved. A client asking "what does it cost?" is always directed to a consultation first, where the right piece is selected and then priced accurately. Do not give specific figures in the proposal — give ranges and direct them to a consultation.

## LEAD TRIAGE RULES

Score every lead HIGH, MEDIUM, or LOW before calling alert_owner.

HIGH — The client has a specific occasion, a clear brief, and no hesitation about value.
- Bridal enquiry — full or partial bridal set for a wedding
- Custom design — client has a reference, sketch, or clear idea of what they want made
- Corporate gifting — a company buying jewellery for an event, milestone, or client gift
- Budget signals above KWD 7,500 — "not price-sensitive", "want the best", specific high figure
- Arab family buyer with a named occasion (Eid, engagement, wedding) and intent to buy for family
- Returning Devji client from Bahrain or elsewhere in the GCC

MEDIUM — Genuine interest and a real occasion, but one or more signals are unclear.
- Single-piece jewellery consultation with a real occasion but unspecified or vague budget
- Expat buyer interested in gold jewellery for investment or everyday wear
- Bridal enquiry for only one or two pieces, not a full set
- Researching for an upcoming occasion 3-6 months away — real interest, not urgent
- Budget described as "reasonable", "depends on the piece", or somewhere between KWD 1,000 and 7,500

LOW — No clear occasion, no real brief, or price-sensitivity that does not fit the boutique model.
- No occasion mentioned — browsing, curious, no intent signal
- Price is the first concern — "cheapest", "offers", "match another price"
- Enquiry is a question the chatbot could have answered
- Budget explicitly below KWD 1,000

## PROPOSAL STRUCTURE

Write exactly 4 sections:
1. What You Are Looking For — show you listened to their specific situation; reflect their brief back to them accurately
2. What Devji Brings — which product line fits, why it is right for their occasion, what the consultation experience looks like
3. How We Work Together — the appointment format (90 minutes, private consultation room, The Avenues Mall Kuwait), custom design process if relevant, timeline from consultation to piece
4. Next Steps — book an appointment at The Avenues, contact appointments.kuwait@devji.com, or reply to this email

## INSTRUCTIONS
- Write the proposal in Jaydeep's voice — direct, personal, specific to their situation
- Score the lead using the triage rules (HIGH/MEDIUM/LOW)
- Call render_proposal_pdf with the 4 proposal sections
- Call send_email with a short, warm cover email (3-4 sentences max) and the PDF attached. The email should feel like Jaydeep wrote it himself — not a system notification.
- If the store_lead tool is available, call it with all lead data and the score
- Call alert_owner with: company/client name, challenge, score, and one line explaining why you scored it that way
- You can call render_proposal_pdf and store_lead in parallel. Send email only after the PDF is ready. Alert owner last.`;

// ── Main handler ────────────────────────────────────────────────────────────
// Works as both Express route (local dev) and Vercel serverless function

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { conversation, intakeData } = req.body;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured' });

  if (!conversation && !intakeData) {
    return res.status(400).json({ error: 'conversation or intakeData required' });
  }

  // Reset PDF state for this request
  proposalPdfBase64 = null;

  // Build context from intake data or conversation transcript
  const intakeContext = intakeData
    ? `VISITOR INTAKE DATA:\n${JSON.stringify(intakeData, null, 2)}`
    : `CONVERSATION TRANSCRIPT:\n${conversation.map(m => `${m.role}: ${m.content}`).join('\n')}`;

  // Build tools list — store_lead only available if Supabase is configured
  const tools = getTools();
  const supabaseEnabled = tools.some(t => t.function?.name === 'store_lead');
  console.log(`Agent starting with ${tools.length} tools${supabaseEnabled ? ' (Supabase enabled)' : ''}`);

  let messages = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    { role: 'user', content: `${intakeContext}\n\nPlease write a personalized proposal, score this lead, and use your tools to send everything.` },
  ];

  const results = { proposal: false, email: false, stored: false, alerted: false };

  // ── Agent loop — max 5 turns for safety ──
  for (let turn = 1; turn <= 5; turn++) {
    console.log(`Agent turn ${turn}...`);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': req.headers?.host ? `https://${req.headers.host}` : 'http://localhost:3000',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4.6',
        messages,
        tools,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Agent OpenRouter error:', err);
      return res.status(502).json({ error: 'Agent API call failed', details: err });
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) {
      console.error('Agent: no choice in response');
      break;
    }

    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    // No tool calls = agent is done thinking
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      console.log(`Agent turn ${turn}... Agent completed.`);
      break;
    }

    // Execute each tool call
    const toolNames = assistantMessage.tool_calls.map(tc => tc.function.name);
    console.log(`Agent turn ${turn}... Claude called ${assistantMessage.tool_calls.length} tool(s): ${toolNames.join(', ')}`);

    for (const toolCall of assistantMessage.tool_calls) {
      let args;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch (e) {
        console.error(`Failed to parse tool args for ${toolCall.function.name}:`, e.message);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({ error: 'Failed to parse arguments' }),
        });
        continue;
      }

      const result = await executeTool(toolCall.function.name, args);

      // Track what succeeded
      if (toolCall.function.name === 'render_proposal_pdf' && result.success) results.proposal = true;
      if (toolCall.function.name === 'send_email' && result.success) results.email = true;
      if (toolCall.function.name === 'store_lead' && result.success) results.stored = true;
      if (toolCall.function.name === 'alert_owner' && result.success) results.alerted = true;

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  console.log('Agent pipeline complete:', results);
  return res.json({ success: true, results });
};
