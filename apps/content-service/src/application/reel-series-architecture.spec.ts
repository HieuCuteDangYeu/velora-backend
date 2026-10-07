import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const directory = join(__dirname, 'use-cases');
const files = readdirSync(directory).filter((file) =>
  /series.*\.use-case\.ts$/.test(file),
);

describe('reel series clean architecture', () => {
  it('has one execute operation per use-case class and no infrastructure imports', () => {
    expect(files).toHaveLength(9);
    for (const file of files) {
      const source = ts.createSourceFile(
        file,
        readFileSync(join(directory, file), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const classes = source.statements.filter(ts.isClassDeclaration);
      expect(classes).toHaveLength(1);
      expect(
        classes[0].members
          .filter(ts.isMethodDeclaration)
          .map((method) => method.name.getText(source)),
      ).toEqual(['execute']);
      for (const statement of source.statements.filter(
        ts.isImportDeclaration,
      )) {
        expect(statement.moduleSpecifier.getText(source)).not.toMatch(
          /infrastructure|@nestjs\/config|@nestjs\/microservices|@prisma/,
        );
      }
    }
    expect(
      readFileSync(
        join(__dirname, 'services/reel-series-access.service.ts'),
        'utf8',
      ),
    ).not.toMatch(
      /infrastructure|@nestjs\/config|@nestjs\/microservices|@prisma/,
    );
  });
});
