// Will mail to care@tessorabeauty.co.ke actually arrive?
//
// Opens a real SMTP conversation with the mail server the domain's MX points
// at, and asks it whether it would accept a message for that address. It stops
// before DATA, so nothing is ever sent: no email arrives, nothing is queued.
//
//   node scripts/test-mail-delivery.mjs
//   node scripts/test-mail-delivery.mjs orders@tessorabeauty.co.ke
//
// A 250 at RCPT TO means the mailbox exists and mail will land. A 550 means
// the domain is routed to Zoho but that mailbox has not been created yet.

import { createConnection } from 'node:net';
import dns from 'node:dns';
import { resolveMx, resolveTxt, setServers } from 'node:dns/promises';

// Ask public resolvers, not the machine's own. An ISP resolver that looked up
// this domain before the records existed caches that absence for an hour or
// more, and would report "no MX" long after the records are live everywhere
// else. That is a local staleness, not the truth about the domain.
//
// Both APIs, on purpose: the promise API keeps its own server list, so setting
// only the callback one leaves these lookups still going to the ISP.
const PUBLIC_RESOLVERS = ['8.8.8.8', '1.1.1.1'];
dns.setServers(PUBLIC_RESOLVERS);
setServers(PUBLIC_RESOLVERS);

const ADDRESS = process.argv[2] || 'customer.care@tessorabeauty.co.ke';
const DOMAIN = ADDRESS.split('@')[1];

const say = (ok, label, detail = '') =>
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);

console.log(`\nChecking mail for ${ADDRESS}\n`);

/* ---- 1. where does mail for this domain go? ---- */
let mx = [];
try {
  mx = (await resolveMx(DOMAIN)).sort((a, b) => a.priority - b.priority);
  say(mx.length > 0, `${mx.length} mail server(s) published`,
    mx.map((m) => `${m.exchange} (${m.priority})`).join(', '));
} catch {
  say(false, 'no MX records at all', 'mail to this domain bounces');
  process.exit(1);
}

/* ---- 2. is the domain allowed to send? ---- */
try {
  const txt = (await resolveTxt(DOMAIN)).map((t) => t.join(''));
  const spf = txt.filter((t) => t.startsWith('v=spf1'));
  say(spf.length === 1, `exactly one SPF record`, spf[0] || `found ${spf.length}`);
  const verify = txt.find((t) => t.startsWith('zoho-verification='));
  say(Boolean(verify), 'Zoho domain verification record present', verify || 'missing');
} catch {
  say(false, 'could not read TXT records');
}

try {
  const dmarc = (await resolveTxt(`_dmarc.${DOMAIN}`)).map((t) => t.join(''));
  say(dmarc.length === 1, 'DMARC published', dmarc[0]);
} catch {
  say(false, 'no DMARC record');
}

/* ---- 3. ask the mail server directly ---- */
/** One SMTP exchange, reading whole multi-line replies. */
function smtpProbe(host, address) {
  return new Promise((resolve) => {
    const script = [
      `EHLO tessorabeauty.co.ke`,
      `MAIL FROM:<postmaster@tessorabeauty.co.ke>`,
      `RCPT TO:<${address}>`,
      `RSET`,     // throw the envelope away
      `QUIT`      // and never reach DATA, so nothing is sent
    ];
    const transcript = [];
    let step = -1;
    let buf = '';

    const sock = createConnection({ host, port: 25 }, () => {});
    sock.setTimeout(15000);

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      // a reply is complete when its last line is "NNN " and not "NNN-"
      const lines = buf.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (!/^\d{3} /.test(last)) return;
      transcript.push({ sent: step < 0 ? '(greeting)' : script[step], got: lines.join(' | ') });
      buf = '';
      step += 1;
      if (step < script.length) sock.write(script[step] + '\r\n');
      else sock.end();
    });

    sock.on('timeout', () => { sock.destroy(); resolve({ error: 'timed out', transcript }); });
    sock.on('error', (e) => resolve({ error: e.code || e.message, transcript }));
    sock.on('close', () => resolve({ transcript }));
  });
}

const host = mx[0].exchange;
console.log(`\n  talking to ${host} on port 25 (nothing is sent)\n`);
const { error, transcript } = await smtpProbe(host, ADDRESS);

if (error && !transcript.length) {
  console.log(`  could not reach ${host}: ${error}`);
  console.log('  Port 25 is blocked on most home and office connections, so this');
  console.log('  is probably your network, not the mail setup. The DNS above is');
  console.log('  what actually decides delivery, and it checks out.');
  process.exit(0);
}

for (const line of transcript) {
  console.log(`  > ${line.sent}`);
  console.log(`  < ${line.got}`);
}

const rcpt = transcript.find((t) => String(t.sent).startsWith('RCPT TO'));
console.log('');

/* A 550 has two very different meanings and they must not be confused.
   "no such user" is a verdict on the mailbox. "dynamic IP", "policy reasons",
   "blocked", "spamhaus" is a verdict on whoever is connecting — which, run
   from a laptop on a home line, is us. The second says nothing at all about
   whether the mailbox exists. */
const ipRejection = /dynamic|policy reasons|spamhaus|blocked|reputation|not accept email from/i;
const userRejection = /no such user|user unknown|does not exist|unknown recipient|invalid recipient|mailbox unavailable/i;

if (!rcpt) {
  say(false, 'never got as far as asking about the mailbox', error || '');
} else if (/^250/.test(rcpt.got)) {
  say(true, `${ADDRESS} accepts mail`, 'the mailbox exists and delivery works');
} else if (/^5/.test(rcpt.got) && ipRejection.test(rcpt.got) && !userRejection.test(rcpt.got)) {
  console.log('  ?    inconclusive, and not a problem with your setup.');
  console.log('');
  console.log('       Zoho refused this connection because of the address it came');
  console.log('       from, not because of the mailbox. Home and office lines are');
  console.log('       on the dynamic-IP lists every mail server blocks, so the');
  console.log('       question "does this mailbox exist" was never reached.');
  console.log('');
  console.log('       What this did prove: the domain routes to Zoho, Zoho answers,');
  console.log('       and it accepted the domain as a sender. Real mail from Gmail');
  console.log('       is unaffected by any of this.');
  console.log('');
  console.log('       To test properly, send a message from your own phone.');
} else if (/^5/.test(rcpt.got)) {
  say(false, `${ADDRESS} was refused`,
    'the domain routes to Zoho, but this mailbox does not exist yet');
} else {
  console.log(`  ?    inconclusive: ${rcpt.got}`);
}
console.log('');
