import { Controller, Get, INestApplication, Query } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  AddReelToSeriesSchema,
  ListReelSeriesCandidateReelsQueryDto,
  ListReelSeriesCandidateReelsQuerySchema,
  ListReelSeriesCandidateReelsRpcQuerySchema,
} from './reel-series.dto';

@Controller('test')
class ReelSeriesSwaggerTestController {
  @Get()
  list(@Query() query: ListReelSeriesCandidateReelsQueryDto) {
    return query;
  }
}

describe('AddReelToSeriesSchema', () => {
  it('accepts a unique ordered reelIds batch', () => {
    expect(
      AddReelToSeriesSchema.safeParse({ reelIds: ['reel-1', 'reel-2'] })
        .success,
    ).toBe(true);
  });

  it('rejects the legacy single reelId payload and duplicate ids', () => {
    expect(AddReelToSeriesSchema.safeParse({ reelId: 'reel-1' }).success).toBe(
      false,
    );
    expect(
      AddReelToSeriesSchema.safeParse({ reelIds: ['reel-1', 'reel-1'] })
        .success,
    ).toBe(false);
  });
});

describe('reel series candidate cursor', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ReelSeriesSwaggerTestController],
    }).compile();

    app = moduleRef.createNestApplication();
  });

  afterAll(async () => {
    await app.close();
  });

  it('remains representable in Swagger and survives the gateway-to-RPC parse', () => {
    expect(() =>
      SwaggerModule.createDocument(app, new DocumentBuilder().build()),
    ).not.toThrow();

    const gatewayQuery = ListReelSeriesCandidateReelsQuerySchema.parse({
      cursor: '2026-09-18T00:00:00.000Z|reel-1',
    });
    const rpcQuery =
      ListReelSeriesCandidateReelsRpcQuerySchema.parse(gatewayQuery);

    expect(rpcQuery.cursor).toEqual({
      createdAt: new Date('2026-09-18T00:00:00.000Z'),
      id: 'reel-1',
    });
  });
});
