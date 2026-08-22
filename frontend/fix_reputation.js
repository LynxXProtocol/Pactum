const fs = require('fs');
let content = fs.readFileSync('src/components/ReputationDashboard.tsx', 'utf8');

// I will just use regex to extract the parts and reconstruct them.
// Or even easier, I will just open it in vim? No.
