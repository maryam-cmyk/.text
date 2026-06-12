const express = require('express');
const app = express();
const PORT = 5002;

const mockEntities = require('./data/mockEntities');
const nadraData = require('./data/nadraData.json');
const iescoData = require('./data/iescoData.json');
const fbrData = require('./data/fbrData.json');
const travelData = require('./data/travelData.json');

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS — allow UI dev server on any localhost port
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

// ── Root ──────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.status(200).json({
    message: 'Welcome to AI Tax Portal Backend',
    version: '1.0.0'
  });
});

// ── Mock API: Entities ────────────────────────────────────────────────────────

// --- Mapping Functions ---

function mapNadraToEntityBase(nadraData) {
  return {
    id: `ent-${nadraData.cnic.slice(-5)}`,
    cnic: nadraData.cnic,
    fullName: nadraData.fullName,
    aliases: nadraData.aliases,
    dateOfBirth: nadraData.dateOfBirth,
    profession: nadraData.profession,
    addresses: nadraData.addresses.map(addr => ({
      street: addr.street,
      city: addr.city,
      province: addr.province,
      source: 'NADRA',
    })),
  };
}

function mapFbrToTaxAndProperties(fbrData) {
  return {
    taxFilings: fbrData.taxFilings.map(tf => ({
      ...tf,
      category: 'Salaried / Business',
    })),
    properties: fbrData.properties,
    vehicles: fbrData.vehicles,
  };
}

function mapIescoToUtilityBills(iescoData) {
    const totalAmount = iescoData.bills.reduce((sum, h) => sum + h.amountPKR, 0);
    const totalUnits = iescoData.bills.reduce((sum, h) => sum + h.units, 0);
    const count = iescoData.bills.length;

    return {
        utilityBills: [
            {
                type: 'electricity',
                provider: 'IESCO',
                averageMonthlyAmount: count > 0 ? totalAmount / count : 0,
                averageMonthlyUnits: count > 0 ? totalUnits / count : 0,
                connectionAddress: iescoData.connectionAddress,
            }
        ]
    };
}

function mapTravelToTravelRecords(travelData) {
  return {
    travelRecords: travelData.trips,
  };
}

function buildComplianceScore(taxFilings, properties, utilityBills, travelRecords) {
    const latestFiling = taxFilings.find(f => f.year === 2023);
    const totalDeclaredIncome = latestFiling?.declaredIncome || 0;
    const totalPropertyValue = properties.reduce((sum, p) => sum + p.estimatedValuePKR, 0);
    const avgUtilityBill = utilityBills.find(u => u.type === 'electricity')?.averageMonthlyAmount || 0;

    const assetVsIncome = totalDeclaredIncome > 0 ? (totalPropertyValue / totalDeclaredIncome) / 10 : 50; // Scaled
    const utilityVsIncome = totalDeclaredIncome > 0 ? ((avgUtilityBill * 12) / totalDeclaredIncome) * 100 : 30;
    const travelVsIncome = travelRecords.length * 5; // Simple heuristic
    const filingConsistency = taxFilings.some(f => f.filingStatus === 'late' || f.filingStatus === 'not_filed') ? 40 : 10;

    const total = Math.min(100, Math.round(assetVsIncome + utilityVsIncome + travelVsIncome + filingConsistency));
    let level = 'low';
    if (total > 75) level = 'high';
    else if (total > 50) level = 'medium';

    return {
        total,
        level,
        breakdown: {
            incomeVsLifestyle: 0, // Placeholder
            assetVsIncome: Math.round(assetVsIncome),
            utilityVsIncome: Math.round(utilityVsIncome),
            travelVsIncome: Math.round(travelVsIncome),
            filingConsistency: Math.round(filingConsistency),
        },
    };
}

function buildMockEntity(nadraData, fbrData, iescoData, travelData) {
  const nadraPart = mapNadraToEntityBase(nadraData);
  const fbrPart = mapFbrToTaxAndProperties(fbrData);
  const iescoPart = mapIescoToUtilityBills(iescoData);
  const travelPart = mapTravelToTravelRecords(travelData);

  const complianceScore = buildComplianceScore(fbrPart.taxFilings, fbrPart.properties, iescoPart.utilityBills, travelPart.travelRecords);

  const auditTrail = [];
  if (complianceScore.breakdown.assetVsIncome > 30) {
      auditTrail.push({ id: 'aud-001', timestamp: new Date().toISOString(), category: 'Asset Discrepancy', finding: 'Asset value disproportionate to declared income', severity: 'high', dataSource: 'FBR', detail: 'Total property value is 7x annual income.' });
  }

  const entity = {
    ...nadraPart,
    ...fbrPart,
    ...iescoPart,
    ...travelPart,
    complianceScore,
    caseStatus: 'open',
    auditTrail,
    analystNotes: [
        { id: 'note-1', authorName: 'System', timestamp: new Date().toISOString(), content: 'Entity profile created from multiple data sources.' }
    ],
    flaggedAt: new Date().toISOString(),
    assignedAnalyst: 'Unassigned',
  };

  return entity;
}

async function getMockEntity(req, res) {
  const entity = buildMockEntity(nadraData, fbrData, iescoData, travelData);
  res.json({ entity });
}

// GET /api/entities/mock - get a fully mocked entity
app.get('/api/entities/mock', getMockEntity);

// GET /api/entities  — list all entities (full objects, with optional filters)
app.get('/api/entities', (req, res) => {
  const { query, riskLevel, caseStatus, province } = req.query;

  // Return full entity objects so the UI can access addresses, profession, etc.
  let results = [...mockEntities];

  if (riskLevel)  results = results.filter(e => e.complianceScore.level === riskLevel);
  if (caseStatus) results = results.filter(e => e.caseStatus === caseStatus);
  if (province)   results = results.filter(e =>
    e.addresses.some(a => a.province.toLowerCase().includes(province.toLowerCase()))
  );
  if (query) {
    const q = query.toLowerCase();
    results = results.filter(e =>
      e.fullName.toLowerCase().includes(q) ||
      e.cnic.includes(q) ||
      e.profession.toLowerCase().includes(q)
    );
  }

  res.status(200).json({ entities: results, total: results.length });
});

// GET /api/entities/:id  — full entity detail
app.get('/api/entities/:id', (req, res) => {
  const entity = mockEntities.find(e => e.id === req.params.id);
  if (!entity) {
    return res.status(404).json({ error: 'Entity not found', id: req.params.id });
  }
  res.status(200).json({ entity });
});

// GET /api/entities/cnic/:cnic  — look up by CNIC
app.get('/api/entities/cnic/:cnic', (req, res) => {
  const entity = mockEntities.find(e => e.cnic === req.params.cnic);
  if (!entity) {
    return res.status(404).json({ error: 'Entity not found', cnic: req.params.cnic });
  }
  res.status(200).json({ entity });
});

// PATCH /api/entities/:id/status  — update case status
app.patch('/api/entities/:id/status', (req, res) => {
  const { caseStatus } = req.body;
  const validStatuses = ['open', 'under_review', 'escalated', 'closed'];
  if (!validStatuses.includes(caseStatus)) {
    return res.status(400).json({ error: 'Invalid caseStatus value', validStatuses });
  }
  const entity = mockEntities.find(e => e.id === req.params.id);
  if (!entity) {
    return res.status(404).json({ error: 'Entity not found', id: req.params.id });
  }
  entity.caseStatus = caseStatus;
  res.status(200).json({ message: 'Case status updated', id: entity.id, caseStatus });
});

// POST /api/entities/:id/notes  — add analyst note
app.post('/api/entities/:id/notes', (req, res) => {
  const { authorName, content } = req.body;
  if (!authorName || !content) {
    return res.status(400).json({ error: 'authorName and content are required' });
  }
  const entity = mockEntities.find(e => e.id === req.params.id);
  if (!entity) {
    return res.status(404).json({ error: 'Entity not found', id: req.params.id });
  }
  const note = {
    id: `note-${Date.now()}`,
    authorName,
    timestamp: new Date().toISOString(),
    content
  };
  entity.analystNotes.push(note);
  res.status(201).json({ message: 'Note added', note });
});

// ── Mock API: Dashboard Summary ───────────────────────────────────────────────
app.get('/api/dashboard', (req, res) => {
  res.status(200).json({
    summary: {
      totalEntitiesScanned: 4821,
      flaggedHigh: 312,
      flaggedCritical: 47,
      casesUnderReview: 128,
      newAlertsToday: 9,
      totalRevenueLeakageEstimatePKR: 18750000000
    }
  });
});

// ── Mock API: Alerts ──────────────────────────────────────────────────────────
app.get('/api/alerts', (req, res) => {
  res.status(200).json({
    alerts: [
      {
        id: "alert-001",
        entityId: "ent-00142",
        entityName: "Kamran Ashraf Sheikh",
        cnic: "35202-7891234-5",
        message: "Asset-to-income ratio exceeds threshold: PKR 268M in properties vs PKR 13.85M declared income",
        severity: "critical",
        timestamp: "2024-02-01T09:00:00Z",
        isRead: false
      },
      {
        id: "alert-002",
        entityId: "ent-00142",
        entityName: "Kamran Ashraf Sheikh",
        cnic: "35202-7891234-5",
        message: "Tax return for FY 2023 not filed. Deadline was Sep 30, 2023.",
        severity: "high",
        timestamp: "2024-02-10T10:05:00Z",
        isRead: false
      },
      {
        id: "alert-003",
        entityId: "ent-00142",
        entityName: "Kamran Ashraf Sheikh",
        cnic: "35202-7891234-5",
        message: "Monthly utility bills (~PKR 150,000) disproportionate to declared monthly income (~PKR 312,500)",
        severity: "high",
        timestamp: "2024-02-03T11:40:00Z",
        isRead: true
      }
    ],
    total: 3,
    unread: 2
  });
});

// ── Mock API: Data Sources ────────────────────────────────────────────────────
app.get('/api/data-sources', (req, res) => {
  res.status(200).json({
    sources: [
      { id: "ds-001", name: "NADRA", type: "nadra", description: "National Database & Registration Authority — identity and address records", recordCount: 231000000, lastSynced: "2024-03-10T02:00:00Z", status: "active", fields: ["cnic", "fullName", "dateOfBirth", "address", "phoneNumber"] },
      { id: "ds-002", name: "FBR", type: "fbr", description: "Federal Board of Revenue — tax filings, NTN, wealth statements", recordCount: 4200000, lastSynced: "2024-03-11T01:00:00Z", status: "active", fields: ["ntn", "taxYear", "declaredIncome", "taxPaid", "filingStatus", "wealthStatement"] },
      { id: "ds-003", name: "IESCO / LESCO / Utility DISCOs", type: "utility", description: "Electricity distribution companies — consumption and billing data", recordCount: 29000000, lastSynced: "2024-03-09T03:30:00Z", status: "active", fields: ["connectionId", "consumerCnic", "averageUnits", "averageAmount", "connectionAddress"] },
      { id: "ds-004", name: "Excise & Taxation", type: "excise", description: "Provincial vehicle registration and token tax records", recordCount: 15000000, lastSynced: "2024-03-08T04:00:00Z", status: "active", fields: ["registrationNumber", "ownerCnic", "make", "model", "year", "engineCC"] },
      { id: "ds-005", name: "Property Registration", type: "property", description: "Provincial land registries and DC office transfer records", recordCount: 8700000, lastSynced: "2024-03-07T05:00:00Z", status: "stale", fields: ["registrationId", "ownerName", "propertyType", "location", "area", "estimatedValue"] },
      { id: "ds-006", name: "NADRA Immigration", type: "immigration", description: "Passport control and immigration exit / entry records", recordCount: 61000000, lastSynced: "2024-03-11T00:00:00Z", status: "active", fields: ["passportNumber", "cnic", "destination", "departureDate", "returnDate", "purpose", "airline"] }
    ]
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested endpoint does not exist',
    path: req.path
  });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀  Server running  →  http://localhost:${PORT}`);
  console.log(`📋  Mock API routes:`);
  console.log(`     GET    /health`);
  console.log(`     GET    /api/entities`);
  console.log(`     GET    /api/entities/:id`);
  console.log(`     GET    /api/entities/cnic/:cnic`);
  console.log(`     GET    /api/entities/mock`);
  console.log(`     PATCH  /api/entities/:id/status`);
  console.log(`     POST   /api/entities/:id/notes`);
  console.log(`     GET    /api/dashboard`);
  console.log(`     GET    /api/alerts`);
  console.log(`     GET    /api/data-sources`);
});

module.exports = app;

