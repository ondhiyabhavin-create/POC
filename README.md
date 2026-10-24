# File Intake — Pre-submission Validation (POC)

A generic, rule-driven file validator. Anyone can upload a **CSV or Excel (.xlsx)** file and get immediate, row- and column-specific results (errors vs warnings, a summary, a downloadable report) before they submit the file anywhere. Administrators define **file types** as data — columns, checks, IF/THEN/ELSE rules with formulas, and file-level rules — by hand or **by importing a layout spreadsheet or a sample file**.

It ships with four example file types built from the ODR (Louisiana Office of Debt Recovery) layouts — Placement, Recall, Adjustment and Direct Payment — but nothing in the engine is specific to them.

- **Local mode (default):** runs entirely on your machine. No cloud account, synthetic data only.
- **AWS mode:** the same code on AWS serverless (CloudFront, API Gateway, Lambda, DynamoDB, S3, Cognito) with one deploy command.

---

## 1. Run it locally

Prerequisite: Node.js 22+.

```bash
npm install
npm run dev          # API on http://localhost:4000, web app on http://localhost:5173
```

Open **http://localhost:5173** and click a demo account (password `Password1!`):

| Account | Role |
|---|---|
| `user@ccsv.local` | Submitter in organization *City Court of Somewhereville* (`CCSV`) |
| `user@bpu.local` | Submitter in organization *Bayou Parish Utilities* (`BPU`) |
| `anyone@demo.local` | Submitter with **no organization** — organization-specific checks are skipped |
| `admin@demo.local` | Administrator — rules, organizations, dashboard, all submissions |

```bash
npm test             # engine tests (formulas, conditions, Excel reader, importer, validation)
npm run typecheck
npm run samples      # regenerate ./samples (synthetic CSV + XLSX files)
npm run reset-data   # wipe local data and restore the example rule sets (restart dev afterwards)
```

## 2. What it does

### For anyone validating a file
1. **Validate a file** → pick the file type → drop a `.csv` or `.xlsx` → **Validate**.
2. Results show pass / pass-with-warnings / fail, totals (records passed, with errors, with warnings), issues by category and by column, and every issue with its **row, column, current value and a fix hint** — e.g. *Row 2, Column S (SSN): SSN must be exactly 9 characters (found 8). Leading zeros may have been removed…*
3. **Download error report** (CSV), see the confirmation number on success, and find everything again under **My submissions**. Users see their organization's submissions — or only their own if they have no organization.

### For administrators
- **Validation rules → New file type from spreadsheet** — upload either:
  - a **layout specification** (one row per field with *Field / Datatype / Required / Format* columns, like ODR Attachments D, E, H, I). Data types, required/optional (including "R (for Business)" style conditional requirements), lengths (`#########`, "3 digit"), fixed values ("Hard coded = ADP"), organization-specific values ("Hard coded with information provided…"), allowed lists (`"I" or "C"`, "Possible types: …", "one of the below codes" tables), negative amounts, "same as column L" rules, the file type name/code and naming convention are all read from the text. Real header names are taken from a matching layout/data sheet when present.
  - a **sample data file** — row 1 becomes the columns; types, lengths and required flags are inferred from the values.
  You review every proposed column before it's applied.
- **Columns:** data type (text, digits, integer, money, date CCYY-MM-DD), required/optional, exact/min/max length, regex pattern, allowed values or a lookup list, **must equal a fixed value or the organization's own value**, negative amounts, and per-check severity (error or warning).
- **IF / THEN / ELSE rules** with a visual builder:
  - Conditions combine with **ALL (and) / ANY (or) / NONE (not)** and can be nested in groups.
  - Each side can be a **column, a value or a formula** — e.g. `IF [Debtor Type] equals "I" OR [BJ] + [BK] is greater than 100 THEN SSN is required ELSE FEIN is required`.
  - Actions: is required, must be blank, must equal / not equal, one of / not one of, greater/less than, matches pattern, min/max length, or **must satisfy a formula**. Custom messages are optional.
  - Formulas are spreadsheet-like and checked as you type: `+ - * / &`, comparisons, `AND OR NOT`, and functions such as `IF, LEN, LEFT, RIGHT, MID, UPPER, TRIM, NUM, ISBLANK, ISNUMBER, ISDATE, CONTAINS, MATCHES, IN, SUM, MIN, MAX, ROUND, ABS, TODAY, DAYS, ADDDAYS, YEAR…`. Columns are referenced as `[C]`, `[key]` or `[Header Name]`. Formulas are parsed and interpreted — no code execution.
- **Preset rules:** all-or-none, at-least-one, two columns equal, date order.
- **File rules:** naming convention with tokens `{ORG}_{TYPE}_{YYYYMMDD}.csv` (also accepts `.xlsx`), not empty, duplicate records, duplicate keys (any column combination), and **"value must exist in previously passed files of type X"** (e.g. a recalled debt must have been placed).
- **🧪 Test rules** runs unsaved rules against any file in the browser. Saving bumps the rule-set version; invalid rules (unknown columns, bad formulas or regex) can't be saved.
- **Organizations** (optional): a code for `{ORG}` and any number of named values that columns can be checked against.
- **Lookup lists**, **Dashboard** (error trends by organization, type and field), and **review status** per submission (Validated → Pending review → Processed / Rejected) with an audit trail.

## 3. Demo script

The `samples/` files are synthetic (SSNs start with 9, FEINs with 00).

1. As `user@ccsv.local`: validate `samples/1-valid/CCSV_PLC_<date>.csv` (passes), then `samples/2-with-errors/CCSV_PLC_<date>.csv` (~22 typical problems, incl. the IF/ELSE identity rule and a formula rule), then `samples/2-with-errors/CCSV_DPF_<date>.xlsx` (an Excel file).
2. Validate `samples/1-valid/CCSV_REC_<date>.csv` — passes because those debts were placed in step 1 (cross-file rule).
3. As `anyone@demo.local` (no organization): validate any sample — organization checks are skipped, history is private to you.
4. As `admin@demo.local`: **Validation rules → ⇪ New file type from spreadsheet** → drop an ODR attachment (or `samples/4-import/sample-data-for-import.csv`) → review → **Use N columns** → give it a new code → **IF/THEN & cross-field → + IF / THEN rule** → build a rule → **🧪 Test rules** with a sample → **Save**.

## 4. Project layout

```
packages/
  shared/   Engine (pure TypeScript — runs in Lambda, Node and the browser)
            types.ts       rule model            validator.ts  validation
            expression.ts  formula language      conditions.ts IF/AND/OR/THEN/ELSE
            xlsx.ts        Excel reader          import.ts     spec/sample → columns
            seed.ts        example rule sets     synthetic.ts  fake data
  api/      One Lambda handler + router; local server runs the same handler
            store/  local JSON | DynamoDB     blobs/  local disk | S3     auth/  demo JWT | Cognito
  web/      React + Vite app
infra/      AWS CDK stack
samples/    Synthetic files
```

## 5. Deploying to AWS

```bash
aws configure                     # or export AWS_PROFILE=…
export CDK_DEFAULT_REGION=us-east-1
npm run cdk -- bootstrap          # once per account/region
npm run deploy                    # builds the web app and deploys everything
```

Create users in the printed Cognito user pool (self sign-up is off). Administrators go in the `admin` group; anyone else is a submitter, optionally linked to an organization with `custom:orgId`:

```bash
aws cognito-idp admin-create-user --user-pool-id $POOL --username person@example.gov \
  --user-attributes Name=email,Value=person@example.gov Name=email_verified,Value=true Name=name,Value="Person" Name=custom:orgId,Value=CCSV
aws cognito-idp admin-add-user-to-group --user-pool-id $POOL --username admin@example.gov --group-name admin
```

POC-only settings to revisit before real data: `RemovalPolicy.DESTROY` on data stores, `*` CORS on the files bucket, default CloudFront certificate, no WAF. Out of scope for the POC: FedRAMP/GovCloud, IRS Pub 1075 (FTI) safeguards, OSP 26-04 accessibility certification.

## 6. Assumptions in the example ODR rule sets (confirm with SMEs)

All editable in the UI:
1. SSN/FEIN and names are conditional (IF Debtor Type = "I" THEN SSN, last, first required ELSE FEIN, business name) although the attachments mark them all "R".
2. Recall Debtor Type uses `I`/`B` (Attachment E); Placement uses `I`/`C` (Attachment D).
3. Debt types follow Attachment D, not the BRD list.
4. Direct Payment "Principal Code Name" is `PRINCIPAL` (example row + BRD) although the spec text says "Principal".
5. Adjustment: an "Agency Decrease" should have a negative amount (warning).
6. Duplicate debt ID in a file and "not previously placed" are warnings; exact duplicate records are errors.
