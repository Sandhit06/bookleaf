const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
const source = path.join(projectRoot, 'bookleaf_sample_data.json');
const destination = path.join(__dirname, 'bookleaf_sample_data.json');
const data = JSON.parse(fs.readFileSync(source, 'utf8'));

if (!Array.isArray(data.authors) || data.authors.length !== 10 ||
    data.authors.reduce((count, author) => count + (author.books || []).length, 0) !== 18) {
  throw new Error('Sample dataset must contain 10 authors and 18 books.');
}

fs.writeFileSync(destination, `${JSON.stringify(data, null, 2)}\n`);
console.log('Seeded backend sample data with 10 authors and 18 books. Existing tickets were preserved.');
