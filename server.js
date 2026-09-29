/**
 * GHL RelationCreate webhook handler.
 *
 * GHL (via a Marketplace app) posts every new association relation here.
 * Each rule is keyed by associationId, so adding automation for a new
 * association means adding one entry to RULES.
 *
 * Env: GHL_TOKEN, GHL_LOCATION_ID, PORT (default 3000)
 */

import http from 'node:http';

const API = 'https://services.leadconnectorhq.com';
const { GHL_TOKEN, GHL_LOCATION_ID, PORT = 3000 } = process.env;

if (!GHL_TOKEN || !GHL_LOCATION_ID) {
    console.error('Missing GHL_TOKEN or GHL_LOCATION_ID');
    process.exit(1);
}

const ASSOC = {
    GS_BORROWER: '6a868473af728572d25da475', // contact -> greensheet "Borrower"
    GS_REFERRED_BY: '6a869b68c3a6df6dcb582c2b', // contact -> greensheet "Referred By (Person)"
    CONTACT_REFERRED_BY: '6a8598493f6a8b0d5b07d055' // borrower contact (first) -> referrer contact (second)
};

// ---------- GHL API ----------

async function ghl(method, path, body) {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${GHL_TOKEN}`,
            Version: '2021-07-28',
            Accept: 'application/json',
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
    return json;
}

async function relationsOf(recordId) {
    const all = [];
    const limit = 100;
    for (let skip = 0; ; skip += limit) {
        const { relations = [], total = 0 } = await ghl(
            'GET',
            `/associations/relations/${recordId}?locationId=${GHL_LOCATION_ID}&skip=${skip}&limit=${limit}`
        );
        all.push(...relations);
        if (relations.length < limit || all.length >= total) return all;
    }
}

async function createRelation(associationId, firstRecordId, secondRecordId) {
    return ghl('POST', '/associations/relations', {
        locationId: GHL_LOCATION_ID,
        associationId,
        firstRecordId,
        secondRecordId
    });
}

// ---------- Shared logic ----------

// Link the borrower's "Referred By" contact to the greensheet, unless it already has one.
async function linkReferredBy(greensheetId, referrerId) {
    const gsRelations = await relationsOf(greensheetId);
    if (gsRelations.some((r) => r.associationId === ASSOC.GS_REFERRED_BY)) {
        return `greensheet ${greensheetId}: Referred By already linked`;
    }
    await createRelation(ASSOC.GS_REFERRED_BY, referrerId, greensheetId);
    return `greensheet ${greensheetId}: linked Referred By ${referrerId}`;
}

// ---------- Rules (one per associationId) ----------

const RULES = {
    // Borrower linked to a greensheet -> copy the borrower's Referred By onto it
    async [ASSOC.GS_BORROWER](event) {
        const borrowerId = event.firstObjectKey === 'contact' ? event.firstRecordId : event.secondRecordId;
        const greensheetId = event.firstObjectKey === 'contact' ? event.secondRecordId : event.firstRecordId;

        const referral = (await relationsOf(borrowerId)).find(
            (r) => r.associationId === ASSOC.CONTACT_REFERRED_BY && r.firstRecordId === borrowerId
        );
        if (!referral) return `borrower ${borrowerId} has no Referred By`;
        return linkReferredBy(greensheetId, referral.secondRecordId);
    },

    // Referred By added to a contact later -> fill it on that borrower's greensheets
    async [ASSOC.CONTACT_REFERRED_BY](event) {
        const borrowerId = event.firstRecordId;
        const referrerId = event.secondRecordId;

        const greensheetIds = (await relationsOf(borrowerId))
            .filter((r) => r.associationId === ASSOC.GS_BORROWER && r.firstRecordId === borrowerId)
            .map((r) => r.secondRecordId);
        if (!greensheetIds.length) return `contact ${borrowerId} is not a borrower on any greensheet`;

        const results = [];
        for (const id of greensheetIds) results.push(await linkReferredBy(id, referrerId));
        return results.join('; ');
    }
};

async function handleEvent(event) {
    const rule = RULES[event.associationId];
    if (!rule) return; // includes relations this service creates itself
    if (event.locationId && event.locationId !== GHL_LOCATION_ID) return;
    console.log(`[${new Date().toISOString()}] ${event.type || 'RelationCreate'} ${event.associationId}`);
    console.log('  ->', await rule(event));
}

// ---------- HTTP server ----------

http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200).end('ok');
        return;
    }
    if (req.method !== 'POST' || req.url !== '/ghl/webhook') {
        res.writeHead(404).end();
        return;
    }

    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
        // Acknowledge immediately so GHL doesn't time out, then process
        res.writeHead(200).end('ok');
        let event;
        try {
            event = JSON.parse(raw);
        } catch {
            console.warn('Ignored non-JSON body');
            return;
        }
        handleEvent(event).catch((err) => console.error('  !! ', err.message));
    });
}).listen(PORT, () => console.log(`GHL webhook listening on :${PORT}`));
