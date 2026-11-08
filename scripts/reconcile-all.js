#!/usr/bin/env node
// scripts/reconcile-all.js — cek konsistensi saldo semua user vs ledger.
//
// Penggunaan:
//   node scripts/reconcile-all.js            # remote D1
//   node scripts/reconcile-all.js --local    # local D1
//
// Output: tabel user_id | wallet_balance | ledger_balance | consistent

import { execSync } from "child_process";

const useLocal = process.argv.includes("--local");
const flag = useLocal ? "--local" : "";

function run(sql) {
  const out = execSync(
    `npx wrangler d1 execute nokos-db ${flag} --json --command "${sql.replace(/"/g, '\\"')}"`,
    { encoding: "utf8" },
  );
  // parse output (wrangler prints JSON array)
  const m = out.match(/\[[\s\S]*\]/);
  return m ? JSON.parse(m[0]) : [];
}

function main() {
  console.log("Memeriksa konsistensi ledger...\n");
  const rows = run(`
    SELECT w.user_id, w.balance AS wallet_balance,
           (SELECT COALESCE(SUM(amount),0) FROM wallet_transactions
            WHERE user_id=w.user_id AND status='completed') AS ledger_balance
    FROM wallets w
  `);
  if (rows.length === 0) {
    console.log("Tidak ada wallet. Jalankan migration dulu.");
    return;
  }
  let inconsistent = 0;
  console.log("user_id | wallet | ledger | consistent");
  console.log("--------|--------|--------|-----------");
  for (const r of rows) {
    const ok = r.wallet_balance === r.ledger_balance;
    if (!ok) inconsistent++;
    console.log(`${r.user_id} | ${r.wallet_balance} | ${r.ledger_balance} | ${ok ? "✓" : "✗ MISMATCH"}`);
  }
  console.log(`\nTotal: ${rows.length} wallet, ${inconsistent} inkonsisten.`);
  if (inconsistent > 0) {
    console.error("⚠ Ditemukan inkonsistensi! Periksa audit_log untuk transaksi terakhir.");
    process.exit(1);
  } else {
    console.log("✓ Semua konsisten.");
  }
}

main();
