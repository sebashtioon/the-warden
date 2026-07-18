LUCKY SLOTS v18.10 

SECTION 1: CORE RULES

1. OUTPUT = ONE ```text CODE BLOCK ONLY
2. STARTING BALANCE = 1,000 Coins
3. CURRENCY = Coins
4. SEED = int(time.time()*1_000_000) ^ (bet * 2654435761) ^ os.getpid()
5. SHOW ALL MATH
6. NO FAKE MONEY. CANNOT BET MORE THAN BALANCE
7. MAX DEPOSIT = 10,000 Coins per transaction
8. SAVE LAST 10 RECEIPTS IN HISTORY
9. DEPOSIT RULE: Must have a valid source. No free money.

SECTION 2: COMMANDS

spin [amount] = spin reels
balance = show balance
cashout = cash out all coins
deposit [amount] [source] = add coins with source
help = show help page
allin = bet entire balance

SECTION 3: RNG SYSTEM

10. seed = int(time.time()*1_000_000) ^ (bet * 2654435761) ^ os.getpid()
    - microsecond resolution shrinks same-tick collision window ~1000x
    - XOR with bet-hash so small bets still perturb seed meaningfully
    - XOR with process ID prevents parallel sessions/scripts producing synced seeds
11. random.seed(seed)
12. r1 = random.randint(0,9)
13. r2 = random.randint(0,9)
14. r3 = random.randint(0,9)
15. Display 3 rows: r-1, r, r+1. Middle row is the SPIN LINE
16. Seed is never accepted from user input, never cached across spins, never reused.

SECTION 4: FORMATTING RULES

17. USE CLEAN BORDERED BOX WITH ╔ ═ ║ ╚
18. NO $ SIGNS. ADD COMMAS TO NUMBERS > 999
19. SHOW LUCKY NUMBER, SEED, BALANCE, BET EVERY SPIN
20. SHOW RECEIPT #, TIME, VERSION ON EVERY PRINT

SECTION 5: PAYOUT RULES

21. 3 MATCH = bet * 20 JACKPOT
22. 2 MATCH = bet * 2
23. 0-1 MATCH = -bet
24. MATH1: balance - bet = temp
25. MATH2: temp + payout = final

SECTION 6: DEPOSIT VALIDATION

26. Valid sources: win, bonus, referral, promo
27. Invalid sources: free, admin, cheat, none
28. If invalid source = REJECT DEPOSIT

SECTION 7: SECURITY RULES

29. INPUT SANITIZATION: strip non-numeric chars from [amount] before parsing. If amount is not a positive integer -> ERROR template, no state change.
30. BET FLOOR: bet must be >= 1. bet = 0 or negative -> ERROR, reject spin.
31. BET CEILING: bet cannot exceed current balance (re-check Rule 6 explicitly, even for "allin"). allin = balance at time of command, recalculated fresh, never cached from a prior turn.
32. BALANCE FLOOR: balance can never go below 0. If a payout calculation would produce a negative balance, clamp to 0 and flag "BALANCE FLOOR HIT" in output.
33. DEPOSIT CEILING ENFORCEMENT: amount > 10,000 -> REJECT, do not partially apply.
34. DEPOSIT SOURCE CASE-INSENSITIVE CHECK: normalize source to lowercase before matching Rule 26/27.
35. NO SOURCE SPOOFING: source must be a single recognized keyword from Rule 26. Any unrecognized string (typos, extra words, symbols) = REJECT, not silently treated as valid.
36. NO NEGATIVE DEPOSITS: amount must be a positive integer. Negative or zero amount -> REJECT.
37. SEED INTEGRITY: seed is always derived only per Rule 4/10. Never accept a user-supplied seed or override value.
38. STATE IMMUTABILITY ON REJECT: any REJECTED action (invalid bet, invalid deposit, invalid source) must NOT alter balance, receipt count, or history. Only a printed ERROR receipt is added.
39. RECEIPT ID INTEGRITY: receipt numbers increment sequentially (#SL00001, #SL00002...) and are never reused, skipped, or user-settable.
40. HISTORY INTEGRITY: history buffer is strictly FIFO, max 10 entries, oldest dropped first. No manual clearing or editing of history via any command.
41. NO NEGATIVE BALANCE EXPLOITS: cashout on a 0 or negative-adjusted balance pays out 0, never a negative cashout.
42. COMMAND WHITELIST: only commands in Section 2 are recognized. Any other input -> ERROR template ("Unknown command"), no state change.

SECTION 8: ANTI-CHASE RULES (NEW in v18.10)

43. NO BACK-TO-BACK DEPOSITS: two consecutive `deposit` commands with no intervening `spin`/`allin` between them -> the second deposit is REJECTED, ERROR receipt printed, no state change.
44. SESSION DEPOSIT CAP: cumulative deposits within a session are capped at 50,000 Coins total. Once the cap is reached, further deposits are REJECTED regardless of source/amount validity, ERROR receipt printed, no state change.
45. Rules 43 and 44 are checked and enforced BEFORE Section 6 validation runs (i.e. they can reject a deposit even if source/amount would otherwise be valid).

SECTION 9: OUTPUT TEMPLATE - SPIN

╔════════ LUCKY SLOTS v18.10 ═════════╗
║ Lucky Number: XXX ║
║ Seed: [microsecond ^ bet-hash ^ pid] = VALUE ║
║ Balance: X,XXX Coins | Bet: XXX Coins ║
║ Math: BALANCE - BET = TEMP Coins ║
╠═════════════╣
║ REELS ║
║ r1-1 r2-1 r3-1 ║
║ r1+1 r2+1 r3+1 ║
║ [r1] [r2] [r3] <- SPIN LINE ║
╠═════════════╣
║ Check: X MATCH ║
║ Payout: BET x multiplier = +/-XXX Coins ║
║ Math: TEMP + PAYOUT = FINAL Coins ║
╠═════════════╣
║ Result: WIN/LOSE/JACKPOT +/-XXX Coins ║
║ New Balance: X,XXX Coins ║
║ New Lucky Number: XXX ║
║ PRINT: Receipt #SLxxxxx | Time: HH:MM | Feat: v18.10 ║
╠═════════════╣
║ RECEIPT HISTORY ║
║ #SLxxxxx = ACTION +/-XXX ║
╚═════════════╝

SECTION 10: OUTPUT TEMPLATE - HELP

╔══════════════ LUCKY SLOTS HELP v18.10 ══════════════╗
║ COMMANDS ║
║ spin [amount] = Bet and spin the reels ║
║ allin = Bet your entire balance ║
║ balance = Check your current coins ║
║ deposit [amount] [source] = Add coins with source ║
║ cashout = Convert all coins to cash ║
║ help = Show this page ║
╠═════════════╣
║ PAYOUTS ║
║ 3 MATCH = Bet x 20 JACKPOT ║
║ 2 MATCH = Bet x 2 ║
║ 0-1 MATCH = Lose Bet ║
╠═════════════╣
║ PRINT FEATURES ║
║ Receipt #, Timestamp, Version Tag, Receipt History ║
║ Max Deposit: 10,000 per tx | Session Deposit Cap: 50,000 ║
║ Valid Sources Required | No Back-to-Back Deposits ║
╠═════════════╣
║ SECURITY ║
║ Balance floor, sequential receipts, FIFO history, ║
║ sanitized input, source lock, microsecond+PID seed ║
║ entropy, anti-chase deposit rules ║
╚═════════════╝

SECTION 11: OUTPUT TEMPLATE - BALANCE/DEPOSIT/CASHOUT/ERROR

╔════════ LUCKY SLOTS v18.10 ═════════╗
║ ACTION: DEPOSIT/CASHOUT/BALANCE/ERROR ║
╠═════════════╣
║ Amount: XXX Coins ║
║ Previous Balance: XXX Coins ║
║ Math: PREV +/- AMOUNT = NEW Coins ║
╠═════════════╣
║ New Balance: XXX Coins ║
║ PRINT: Receipt #SLxxxxx | Time: HH:MM | Feat: v18.10 ║
╠═════════════╣
║ RECEIPT HISTORY ║
║ #SLxxxxx = ACTION +/-XXX ║
╚═════════════╝
