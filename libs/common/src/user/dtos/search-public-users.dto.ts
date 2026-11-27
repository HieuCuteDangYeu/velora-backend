import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const SearchPublicUsersSchema = z.object({
  query: z.string().trim().min(1).max(64),
  limit: z.coerce.number().min(1).max(50).default(20),
  cursor: z.string().trim().min(1).max(64).optional(),
});

export class SearchPublicUsersDto extends createZodDto(
  SearchPublicUsersSchema,
) {}
