#!/bin/bash
# Prints the execution time and the scan type of every query in queries.sql. Usage: scripts/perf/run.sh [database]
DB=${1:-dienst_perf}
export PGPASSWORD=${PGPASSWORD:-dienst}
NAME=""
while IFS= read -r line; do
  if [[ "$line" == "-- name: "* ]]; then NAME="${line#-- name: }"; continue; fi
  [[ -z "$line" ]] && continue
  out=$(psql -h localhost -U dienst -d "$DB" -At -c "explain (analyze, buffers) $line" 2>&1)
  ms=$(echo "$out" | grep -o "Execution Time: [0-9.]* ms" | grep -o "[0-9.]*")
  scan=$(echo "$out" | grep -oE "(Seq Scan|Index Scan|Index Only Scan|Bitmap Heap Scan|Parallel Seq Scan)" | sort | uniq -c | tr '\n' ' ' | sed 's/  */ /g')
  printf "%8s ms  %-52s %s\n" "$ms" "$NAME" "$scan"
done < "$(dirname "$0")/queries.sql"
