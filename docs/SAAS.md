# Recompta SaaS — Vision produit

## Ce que vous vendez

**Recompta** = plateforme pour cabinets comptables marocains qui automatise la saisie des factures fournisseurs et la génération du fichier Excel DED TVA.

Chaque **cabinet** paie un abonnement et gère ses propres **clients** (entreprises dont il fait la compta).

## Modèle multi-tenant

```
VOUS (éditeur Recompta)
    │
    ├── Cabinet Comptable A  ← abonnement
    │       ├── Utilisateur 1 (admin)
    │       ├── Utilisateur 2 (comptable)
    │       ├── Client Aichoum
    │       │       └── Déclaration TVA 06/2026
    │       │               ├── factures uploadées
    │       │               └── export Excel
    │       └── Client XYZ
    │
    └── Cabinet Comptable B
            └── ...
```

## Rôles utilisateurs

| Rôle | Droits |
|------|--------|
| **owner** | Crée le cabinet, gère l'abonnement, invite des users |
| **admin** | Gère les clients, les users, toutes les déclarations |
| **comptable** | Importe factures, valide lignes, exporte Excel |

## Fonctionnalités par phase

### Phase 1 — MVP SaaS (en cours)
- [x] Extraction factures + export Excel
- [ ] Inscription / connexion cabinet
- [ ] Création de clients
- [ ] Déclarations par client + période
- [ ] Historique des exports

### Phase 2 — Monétisation
- [ ] Abonnement Stripe (par cabinet, par nb de clients ou factures/mois)
- [ ] Essai gratuit 14 jours
- [ ] Page super-admin (vous) : liste cabinets, stats

### Phase 3 — Produit mature
- [ ] Invitation collaborateurs par email
- [ ] Base fournisseurs partagée (ICE → nom)
- [ ] Envoi factures par email (`factures@cabinet.recompta.ma`)
- [ ] API pour logiciels comptables
- [ ] White-label (logo du cabinet)

## Stack technique recommandée

| Composant | Technologie |
|-----------|-------------|
| Auth + base de données | **Supabase** (projet dédié Recompta) |
| Backend | FastAPI (existant) |
| Frontend | HTML/JS → Next.js (phase 2) |
| Fichiers factures | Supabase Storage |
| OCR / IA | OpenAI Vision |
| Paiement | Stripe Billing |

## Important : projet Supabase **dédié** (ne pas toucher l'existant)

> **⚠️ Ne jamais exécuter les migrations Recompta sur un Supabase déjà utilisé** (autre produit, assurance, etc.).
> Recompta doit avoir **son propre projet Supabase**, totalement séparé.

1. Créez un **nouveau projet** sur https://supabase.com → nom suggéré : `recompta`
2. Dans ce nouveau projet uniquement : SQL Editor → coller `supabase/migrations/001_recompta_saas.sql` → Run
3. Copiez les clés de **ce nouveau projet** dans `backend/.env` (pas celles d'un autre projet)

## Variables d'environnement

```env
# backend/.env
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...   # serveur uniquement, jamais côté navigateur
SUPABASE_JWT_SECRET=your-jwt-secret
```

## Tarification suggérée (Maroc)

| Offre | Prix/mois | Inclus |
|-------|-----------|--------|
| Starter | 299 MAD | 5 clients, 100 factures/mois |
| Pro | 599 MAD | 20 clients, 500 factures/mois |
| Cabinet | 999 MAD | illimité, multi-users |
