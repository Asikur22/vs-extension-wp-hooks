/* Parse a .cpuprofile JSON and print the hottest function stacks. */
const fs = require('fs');
const p = JSON.parse(
	fs.readFileSync('/var/folders/qn/b47kdpsj3kb_rc8cqwbzh22w0000gn/T/exthost-939790.cpuprofile', 'utf8')
);

// Build self-time per node
const samples = p.samples; // array of node ids
const tdelta = p.timeDeltas; // microseconds per sample

const self = new Map();
for (let i = 0; i < samples.length; i++) {
	const id = samples[i];
	const t = tdelta[i] || 0;
	self.set(id, (self.get(id) || 0) + t);
}

const byFn = new Map();
for (const n of p.nodes) {
	const t = self.get(n.id) || 0;
	const fn = (n.callFrame.functionName || '(anonymous)') + '  @' + (n.callFrame.url || '').split('/').pop() + ':' + n.callFrame.lineNumber;
	byFn.set(fn, (byFn.get(fn) || 0) + t);
}

const sorted = [...byFn.entries()].sort((a, b) => b[1] - a[1]);
console.log('=== TOP SELF-TIME FUNCTIONS (µs) ===');
for (const [fn, t] of sorted.slice(0, 20)) {
	console.log((t / 1000).toFixed(1).padStart(8) + ' ms  ' + fn);
}

// Reconstruct the heaviest call stack (bottom-up)
console.log('\n=== HEAVIEST LEAF -> ROOT PATH ===');
let leafId = [...self.entries()].sort((a, b) => b[1] - a[1])[0][0];
const parentOf = new Map();
for (const n of p.nodes) parentOf.set(n.id, n.children || []);
// build parent map
const childToParent = new Map();
for (const n of p.nodes) {
	for (const c of n.children || []) childToParent.set(c, n.id);
}
let cur = leafId;
const stack = [];
while (cur !== undefined) {
	const node = p.nodes.find(n => n.id === cur);
	if (!node) break;
	const cf = node.callFrame;
	stack.push(`${cf.functionName || '(anon)'}  @${(cf.url||'').split('/').pop()}:${cf.lineNumber+1}`);
	cur = childToParent.get(cur);
}
console.log(stack.join('\n  ↑ called by\n'));
