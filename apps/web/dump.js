const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient(); prisma.node.findMany().then(n => console.log(JSON.stringify(n, null, 2))).finally(() => prisma.$disconnect());
