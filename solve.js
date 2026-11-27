// diff-speed: a fast line diff that reproduces makefun-diff 1.0.0's patch
// byte for byte. Dependency-free ES module; run(input) takes {old, new}
// (two texts) and returns the patch as one string.
//
// The rule, from the contest's RULES.txt:
// - A text is cut into lines after every \n (\r is part of its line); a last
//   line with no \n is a line too. Lines are equal only code unit for code
//   unit, the newline or its absence included.
// - The common prefix of lines is kept, then the common suffix of the lines
//   left; between them, Myers's greedy search from the first lines: on each
//   diagonal it keeps the path reaching furthest into the old text, and when
//   a deletion and an insertion reach the same point it keeps the deletion's
//   path; it never moves past either text's end, prunes no edge diagonal,
//   and follows every snake of equal lines as far as it goes. The first path
//   to reach both ends is the script.
// - The patch: a header line, then per hunk a "@ os ol ns nl" line and one
//   line per covered line (= kept, - deleted, + inserted). Each run of
//   changes lists its deletions before its insertions and shows up to 3
//   kept lines before and after it; two runs at most 6 kept lines apart
//   share a hunk. A line that ends its text with no newline is written with
//   one and followed by a line holding just %. Identical texts are the
//   header line alone.
//
// Speed notes: lines are interned to integer ids in the same pass that
// splits them, the Myers trace lives in one growing Int32Array (row d at
// offset d*d, diagonal k at index k + d), and the op stream is assembled
// in a preallocated Int32Array where a keep is 0, so snakes and the kept
// prefix/suffix cost no writes at all.

// Split `text` into lines and intern each line to an id from `ids`,
// pushing the line strings onto `linesOut`. Returns the ids as Int32Array.
function splitIntern(text, ids, linesOut) {
  const idArr = [];
  let start = 0;
  const len = text.length;
  while (start < len) {
    const idx = text.indexOf('\n', start);
    let line;
    if (idx === -1) {
      line = text.slice(start);
      start = len;
    } else {
      line = text.slice(start, idx + 1);
      start = idx + 1;
    }
    linesOut.push(line);
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    idArr.push(id);
  }
  return Int32Array.from(idArr);
}

// Myers greedy search over the middle slices a (old ids) and b (new ids).
// Writes the middle's edit ops (0 keep, 1 delete, 2 insert) into the tail
// of `scratch` and returns the index they start at.
function myersOps(a, b, scratch) {
  const n = a.length;
  const m = b.length;
  let pool = new Int32Array(1 << 16);
  // d = 0: just the opening snake along diagonal 0.
  let x = 0;
  while (x < n && x < m && a[x] === b[x]) x++;
  pool[0] = x;
  let D = x === n && x === m ? 0 : -1;
  for (let d = 1; D < 0; d++) {
    const need = (d + 1) * (d + 1);
    if (need > pool.length) {
      let cap = pool.length;
      while (cap < need) cap *= 4;
      const grown = new Int32Array(cap);
      grown.set(pool);
      pool = grown;
    }
    const pOff = (d - 1) * (d - 1);
    const cOff = d * d;
    // Edge diagonal k = -d: only an insertion can reach it.
    {
      const px = pool[pOff];
      if (px >= 0 && px + d - 1 < m) {
        let xx = px;
        let yy = px + d;
        while (xx < n && yy < m && a[xx] === b[yy]) {
          xx++;
          yy++;
        }
        pool[cOff] = xx;
        if (xx === n && yy === m) D = d;
      } else {
        pool[cOff] = -1;
      }
    }
    if (D < 0) {
      for (let k = -d + 2; k <= d - 2; k += 2) {
        const ci = cOff + k + d;
        const pxDel = pool[pOff + k + d - 2];
        const pxIns = pool[pOff + k + d];
        let x0 = -1;
        if (pxDel >= 0 && pxDel < n) {
          if (pxIns >= 0 && pxIns - (k + 1) < m) {
            x0 = pxDel + 1 >= pxIns ? pxDel + 1 : pxIns;
          } else {
            x0 = pxDel + 1;
          }
        } else if (pxIns >= 0 && pxIns - (k + 1) < m) {
          x0 = pxIns;
        }
        if (x0 < 0) {
          pool[ci] = -1;
          continue;
        }
        let xx = x0;
        let yy = x0 - k;
        while (xx < n && yy < m && a[xx] === b[yy]) {
          xx++;
          yy++;
        }
        pool[ci] = xx;
        if (xx === n && yy === m) {
          D = d;
          break;
        }
      }
    }
    if (D < 0) {
      // Edge diagonal k = d: only a deletion can reach it.
      const px = pool[pOff + 2 * (d - 1)];
      if (px >= 0 && px < n) {
        let xx = px + 1;
        let yy = xx - d;
        while (xx < n && yy < m && a[xx] === b[yy]) {
          xx++;
          yy++;
        }
        pool[cOff + 2 * d] = xx;
        if (xx === n && yy === m) D = d;
      } else {
        pool[cOff + 2 * d] = -1;
      }
    }
  }
  // Walk the trace back from (n, m). Ops land in scratch from its end
  // backwards; keeps are 0 and the array is already zero there, so a
  // snake only moves the write cursor.
  let w = n + m;
  let bx = n;
  let by = m;
  for (let d = D; d >= 1; d--) {
    const pOff = (d - 1) * (d - 1);
    const k = bx - by;
    let prevK;
    let prevX;
    if (k === -d) {
      prevK = k + 1;
      prevX = pool[pOff + prevK + d - 1];
    } else if (k === d) {
      prevK = k - 1;
      prevX = pool[pOff + prevK + d - 1];
    } else {
      const pxDel = pool[pOff + k - 1 + d - 1];
      const pxIns = pool[pOff + k + 1 + d - 1];
      const delOk = pxDel >= 0 && pxDel < n;
      const insOk = pxIns >= 0 && pxIns - (k + 1) < m;
      if (delOk && (!insOk || pxDel + 1 >= pxIns)) {
        prevK = k - 1;
        prevX = pxDel;
      } else {
        prevK = k + 1;
        prevX = pxIns;
      }
    }
    const prevY = prevX - prevK;
    if (prevK === k - 1) {
      // A deletion, then (going backwards) the snake that followed it.
      w -= bx - (prevX + 1);
      scratch[--w] = 1;
    } else {
      // An insertion, then the snake that followed it.
      w -= bx - prevX;
      scratch[--w] = 2;
    }
    bx = prevX;
    by = prevY;
  }
  // The opening snake at d = 0.
  w -= bx;
  return w;
}

function emitLine(parts, ch, line) {
  if (line.charCodeAt(line.length - 1) === 10) {
    parts.push(ch + line);
  } else {
    parts.push(ch + line + '\n%\n');
  }
}

// ops[0..total): 0 keep, 1 delete, 2 insert, in order over a (old) and
// b (new). Builds the patch text.
function buildPatch(a, b, ops, total) {
  const N = a.length;
  const M = b.length;
  let deleted = 0;
  let inserted = 0;
  // Maximal runs of changes, grouped into hunks (hunk op ranges hs..he,
  // context included). Runs at most 6 kept lines apart share a hunk.
  const hunks = [];
  let i = 0;
  let hStart = -1;
  let hEnd = -1;
  while (i < total) {
    if (ops[i] === 0) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < total && ops[j] !== 0) {
      if (ops[j] === 1) deleted++;
      else inserted++;
      j++;
    }
    if (ops[i] === 1) deleted++;
    else inserted++;
    if (hStart < 0) {
      hStart = i;
      hEnd = j;
    } else if (i - hEnd <= 6) {
      hEnd = j;
    } else {
      hunks.push(hStart, hEnd);
      hStart = i;
      hEnd = j;
    }
    i = j;
  }
  if (hStart < 0) {
    return (
      'makefun-diff/1 old=' + N + ' new=' + M +
      ' hunks=0 deleted=0 inserted=0\n'
    );
  }
  hunks.push(hStart, hEnd);
  const parts = [];
  parts.push(
    'makefun-diff/1 old=' + N + ' new=' + M +
    ' hunks=' + hunks.length / 2 +
    ' deleted=' + deleted + ' inserted=' + inserted + '\n'
  );
  // Walk the ops once, in order, tracking old/new line positions.
  let oi = 0;
  let ni = 0;
  let pos = 0;
  for (let g = 0; g < hunks.length; g += 2) {
    const hs = Math.max(0, hunks[g] - 3);
    const he = Math.min(total, hunks[g + 1] + 3);
    // Between the previous hunk's end and this one's start: only keeps.
    oi += hs - pos;
    ni += hs - pos;
    pos = hs;
    let ol = 0;
    let nl = 0;
    for (let p = hs; p < he; p++) {
      if (ops[p] !== 2) ol++;
      if (ops[p] !== 1) nl++;
    }
    parts.push('@ ' + (oi + 1) + ' ' + ol + ' ' + (ni + 1) + ' ' + nl + '\n');
    let p = hs;
    while (p < he) {
      if (ops[p] === 0) {
        emitLine(parts, '=', a[oi]);
        oi++;
        ni++;
        p++;
      } else {
        // One run of changes: its deletions first, then its insertions.
        let q = p + 1;
        while (q < he && ops[q] !== 0) q++;
        for (let t = p; t < q; t++) {
          if (ops[t] === 1) emitLine(parts, '-', a[oi++]);
        }
        for (let t = p; t < q; t++) {
          if (ops[t] === 2) emitLine(parts, '+', b[ni++]);
        }
        p = q;
      }
    }
    pos = he;
  }
  return parts.join('');
}

export function run(input) {
  const ids = new Map();
  const a = [];
  const b = [];
  const ai = splitIntern(input.old, ids, a);
  const bi = splitIntern(input.new, ids, b);
  const N = a.length;
  const M = b.length;
  // Common prefix, then common suffix of what is left.
  let lo = 0;
  const minNM = N < M ? N : M;
  while (lo < minNM && ai[lo] === bi[lo]) lo++;
  let hiA = N;
  let hiB = M;
  while (hiA > lo && hiB > lo && ai[hiA - 1] === bi[hiB - 1]) {
    hiA--;
    hiB--;
  }
  const n = hiA - lo;
  const m = hiB - lo;
  // The op stream: keeps are 0, so only changes are ever written.
  const ops = new Int32Array(N + M);
  let midLen = 0;
  if (n === 0) {
    for (let j = 0; j < m; j++) ops[lo + j] = 2;
    midLen = m;
  } else if (m === 0) {
    for (let i = 0; i < n; i++) ops[lo + i] = 1;
    midLen = n;
  } else {
    const scratch = new Int32Array(n + m);
    const w = myersOps(ai.subarray(lo, hiA), bi.subarray(lo, hiB), scratch);
    midLen = n + m - w;
    ops.set(scratch.subarray(w), lo);
  }
  const total = lo + midLen + (N - hiA);
  return buildPatch(a, b, ops, total);
}
