# Laas

Note temporaire (à retirer plus tard). Pas d’outil, juste le métier.

Plateforme partenaire : **Glovo** (`GLOVOAPP MOROCOO SARL`). L’export s’appelle `laasexport-…xls`. Client facturé : **AICHOUM**.

Les livreurs livrent, encaissent le client (ici quasi tout en `CASH_ON_DELIVERY`), puis Glovo fait **2 virements par mois** (1re et 2e quinzaine).

## Fichiers d’un mois

| Fichier | Rôle |
|---|---|
| `laasexport-AAAA-MM-01_AAAA-MM-31.xls` | Toutes les commandes du mois, téléchargées sur la plateforme |
| Facture `MA-FVR…` datée du **15** | Récap 1re quinzaine + montant du virement |
| Facture `MA-FVR…` datée de **fin de mois** | Récap 2e quinzaine + montant du virement |

Exemple juillet 2026 :

- Excel `laasexport-2026-07-01_2026-07-31.xls` — 323 commandes
- `Invoice-MA-FVR260000816` du 15/07 — 1–15 juillet
- `CD99909_…MA-FVR260000818` du 31/07 — 16–31 juillet

## Excel

| Colonne | Nom | Sens |
|---|---|---|
| A | `order id` | Identifiant (`a-k2bi-……`) — même id que sur la facture |
| C | `status` | `DELIVERED`, `RETURNED_TO_VENDOR`, `CANCELLED` |
| F | `order amount` | Argent encaissé chez le client |
| K | `delivery fee` | Frais de livraison **HT** |

Autres colonnes (pas pour le solde) : date, client, téléphone, motif d’annulation, distance, moyen de paiement.

## Règle de calcul (confirmée)

**Livrée (`DELIVERED`)**

- On prend **F** (collecte) et **K** (frais HT).

**Retournée (`RETURNED_TO_VENDOR`) ou annulée (`CANCELLED`)**

- On **ignore F** : ce n’est pas de l’argent à te virer.
- On prend **seulement K** s’il est > 0 (Glovo te facture quand même le run).
- Si K = 0, la commande n’apparaît pas sur la facture.

**Facture PDF**

- Une ligne `Serv. On Demand {order id}` = un frais K, + **TVA 20 %**.
- Des lignes `Refunds. On Demand` peuvent s’ajouter (absentes de l’Excel).
- En bas :
  - **Total de la facture (TTC)** = frais HT + TVA (± remboursements)
  - **Montant collecté** = somme des F des commandes **livrées** de la quinzaine
  - **Montant à payer au partenaire** (négatif) = **collecté − facture TTC** = le virement

## Ce que juillet vérifie

1re quinzaine (facture 816) — ça colle :

- Collecté Excel (F des livrées 1–15) = **28 911** = facture
- Frais Excel (K de toutes les commandes 1–15) = 3 664
- Moins les 2 refunds PDF (−18,33 et −114) = **3 531,67 HT** = facture
- Virement : 28 911 − 4 260,80 = **24 650,20**

2e quinzaine (facture 818) — le principe est le même, l’Excel est **incomplet** :

- 6 commandes sont sur la facture (`56wr6a`, `ehzuor`, `lu440b`, `p0jtcr`, `qyghig`, `yexj0r`) et **absentes de l’Excel**
- Leurs K (140) expliquent l’écart de frais : 2 620 + 140 = **2 760 HT** = facture
- Collecté facture **19 958** vs livrées Excel 16–31 **19 215** (écart 743) : très probablement le F de ces 6 commandes manquantes
- Virement facture : 19 958 − 3 312 = **16 646**

6 retours Excel avec K = 0 n’ont aucune ligne facture — cohérent avec la règle.

## À valider plus tard (pas maintenant)

- Un export Excel peut omettre des commandes déjà facturées.
- Les refunds ne sont pas des lignes Excel.
- S’il y a un jour un paiement autre que cash, F voudra-t-il encore dire « encaissé par le livreur » ?
- Découpage des quinzaines : ici c’est bien le **15** / **fin de mois** sur la date de création.
