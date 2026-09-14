// Deliberately hostile fixture: the parent executor must terminate this process
// without blocking Genesis or the test process.
let accumulator = 0;
for (;;) accumulator = (accumulator + 1) % Number.MAX_SAFE_INTEGER;
