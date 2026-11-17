import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const files = [
  'use-cases/get-reel-subtitles.use-case.ts',
  'use-cases/pre-translate-reel-subtitles.use-case.ts',
  'services/reel-subtitle-translator.service.ts',
];

const parse = (file: string) =>
  ts.createSourceFile(
    file,
    readFileSync(join(__dirname, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );

describe('reel subtitles clean architecture', () => {
  it('keeps one execute operation per use case', () => {
    for (const file of files.filter((name) => name.endsWith('.use-case.ts'))) {
      const source = parse(file);
      const classes = source.statements
        .filter(ts.isClassDeclaration)
        .filter((declaration) => declaration.name?.text.endsWith('UseCase'));
      expect(classes).toHaveLength(1);
      expect(
        classes[0].members
          .filter(ts.isMethodDeclaration)
          .filter(
            (method) =>
              !method.modifiers?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword,
              ),
          )
          .map((method) => method.name.getText(source)),
      ).toEqual(['execute']);
    }
  });

  it('depends on domain ports, not on infrastructure or transport clients', () => {
    for (const file of files) {
      const source = parse(file);
      for (const statement of source.statements.filter(
        ts.isImportDeclaration,
      )) {
        expect(statement.moduleSpecifier.getText(source)).not.toMatch(
          /infrastructure|@nestjs\/config|@nestjs\/microservices|@prisma/,
        );
      }
    }
  });
});
