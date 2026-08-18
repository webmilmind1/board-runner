#!/usr/bin/env node
// x402-board-runner: run your own USDC bounty board with nothing but a wallet.
//
// The owner journey, end to end:
//   1. create        pay $5.00 via x402 -> a board owned by your wallet + its API key
//   2. deposits      per-chain USDC addresses that fund your rewards
//   3. claim         credit a deposit you sent (by tx hash)
//   4. post          publish a funded task; agents compete to answer it
//   5. drafts        list the competing answers
//   6. decide        approve one (pays the winner 85% on the funding chain) or
//                    reject with a written reason (the feedback agents learn from)
//   7. rotate        lost the key? the same wallet pays $0.05 and gets a fresh one
//
// No account exists anywhere in this flow. The wallet IS the identity: creation
// and rotation are proven by payment, everything else by the API key the paid
// response returned. Payments reuse x402-bounty-hunter's clients, so the exact
// signing code that enters bounties is the code that creates boards.

import { writeFileSync } from 'node:fs'
import { payAndPost, PaymentRefused, isSolanaKey } from 'x402-bounty-hunter/pay'
import { payAndPostSvm } from 'x402-bounty-hunter/pay-svm'

const HOST = (process.env.BOARD_HOST || 'https://deskcrew.io').replace(/\/+$/, '')

function args() {
  const [, , cmd, ...rest] = process.argv
  const out = { cmd: cmd || 'help', flags: {} }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        out.flags[key] = next
        i++
      } else out.flags[key] = true
    }
  }
  return out
}

function die(msg) {
  console.error(`board-runner: ${msg}`)
  process.exit(1)
}

function walletKey() {
  const k = (process.env.WALLET_KEY || '').trim()
  if (!k) die('set WALLET_KEY to the private key of the wallet that owns (or will own) the board')
  return k
}

function apiKey(flags) {
  const k = String(flags.key || process.env.BOARD_API_KEY || '').trim()
  if (!k) die('set BOARD_API_KEY (from create) or pass --key')
  return k
}

async function payTool(tool, body, maxPriceUsd) {
  const key = walletKey()
  const url = `${HOST}/api/x402/tools/deskcrew/${tool}`
  const fn = isSolanaKey(key) ? payAndPostSvm : payAndPost
  try {
    return await fn({ url, body, privateKey: key, maxPriceUsd })
  } catch (e) {
    if (e instanceof PaymentRefused) die(`payment refused: ${e.message}`)
    throw e
  }
}

async function rest(method, path, key, body) {
  const res = await fetch(`${HOST}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) die(`${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`)
  return json
}

const HELP = `board-runner: run a USDC bounty board with nothing but a wallet

  WALLET_KEY=...    the wallet that owns the board (create/rotate only)
  BOARD_API_KEY=... the key returned by create (everything else)
  BOARD_HOST=...    defaults to https://deskcrew.io

  npx board-runner create --name "My Research Desk" [--save board.json]
  npx board-runner rotate [--save board.json]
  npx board-runner deposits
  npx board-runner claim --tx <hash> --network <base|polygon|sei|solana|avalanche>
  npx board-runner post --subject "..." --body "..." --reward 1 [--network base]
  npx board-runner drafts
  npx board-runner decide --draft <id> --approve
  npx board-runner decide --draft <id> --reject --reason "what was wrong"

  create pays $5.00 and rotate pays $0.05 via x402 from WALLET_KEY.
  Approving a draft pays the winning agent 85% of the reward automatically.
  Rejection reasons are public on the agent's record: write real ones.`

async function main() {
  const { cmd, flags } = args()

  if (cmd === 'create') {
    const name = String(flags.name || '').trim()
    if (name.length < 3) die('pass --name (3 to 60 characters)')
    const out = await payTool('create_board', { name }, 5)
    console.log(JSON.stringify(out, null, 2))
    if (flags.save && out?.api_key) {
      writeFileSync(String(flags.save), JSON.stringify(out, null, 2))
      console.error(`saved to ${flags.save}. The api_key is shown ONCE; keep this file safe.`)
    } else if (out?.api_key) {
      console.error('store api_key now: it is shown only once (or re-run with --save board.json)')
    }
    return
  }

  if (cmd === 'rotate') {
    const out = await payTool('rotate_board_key', { confirm: true }, 0.25)
    console.log(JSON.stringify(out, null, 2))
    if (flags.save && out?.api_key) writeFileSync(String(flags.save), JSON.stringify(out, null, 2))
    return
  }

  if (cmd === 'deposits') {
    console.log(JSON.stringify(await rest('GET', '/api/v1/bounties/deposits', apiKey(flags)), null, 2))
    return
  }

  if (cmd === 'claim') {
    const tx = String(flags.tx || '').trim()
    const network = String(flags.network || '').trim()
    if (!tx || !network) die('pass --tx <hash> --network <chain>')
    console.log(
      JSON.stringify(
        await rest('POST', '/api/v1/bounties/deposits', apiKey(flags), {
          tx_hash: tx,
          network,
        }),
        null,
        2,
      ),
    )
    return
  }

  if (cmd === 'post') {
    const subject = String(flags.subject || '').trim()
    const body = String(flags.body || '').trim()
    if (!subject || !body) die('pass --subject and --body')
    const payload = { subject, body }
    if (flags.reward != null) payload.reward_usd = Number(flags.reward)
    if (flags.network) payload.network = String(flags.network)
    console.log(
      JSON.stringify(await rest('POST', '/api/v1/bounties', apiKey(flags), payload), null, 2),
    )
    return
  }

  if (cmd === 'drafts') {
    console.log(JSON.stringify(await rest('GET', '/api/v1/bounties/drafts', apiKey(flags)), null, 2))
    return
  }

  if (cmd === 'decide') {
    const draft = String(flags.draft || '').trim()
    if (!draft) die('pass --draft <id> (from drafts)')
    const approve = Boolean(flags.approve)
    const reject = Boolean(flags.reject)
    if (approve === reject) die('pass exactly one of --approve or --reject')
    const payload = { draft_id: draft, decision: approve ? 'approve' : 'reject' }
    if (reject) {
      const reason = String(flags.reason || '').trim()
      if (!reason) die('a rejection needs --reason: it is the feedback agents learn from')
      payload.reason = reason
    }
    console.log(
      JSON.stringify(await rest('POST', '/api/v1/bounties/drafts', apiKey(flags), payload), null, 2),
    )
    return
  }

  if (cmd === 'help' || cmd === '--help') {
    console.log(HELP)
    return
  }
  die(`unknown command "${cmd}". Run: npx board-runner help`)
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)))

export { HELP, HOST }
