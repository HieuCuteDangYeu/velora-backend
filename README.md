# Velora Backend

A production-ready microservices architecture built with NestJS, featuring authentication, user management, media uploads, payments, and email notifications.

## Architecture Overview

This project implements a microservices architecture with the following components:

- **API Gateway** - REST API entry point that routes requests to microservices
- **User Service** - Manages user data and profiles
- **Auth Service** - Handles authentication, authorization, and role management
- **Media Service** - Manages file uploads to AWS S3
- **Payment Service** - Processes payments via Stripe
- **Mail Service** - Sends transactional emails via SendGrid

### Communication

- **RabbitMQ** - Message broker for inter-service communication
- **Redis** - Caching and temporary data storage (verification tokens, reset tokens)
- **BullMQ** - Job queue for email processing

## Features

### Authentication & Authorization

- Email/password registration and login
- Google OAuth2 authentication
- JWT-based authentication with refresh tokens
- Role-based access control (RBAC)
- Email verification
- Password reset flow

### User Management

- CRUD operations for users
- Pagination and search
- Avatar management with S3 integration
- Social login support (Google)

### Media Service

- Pre-signed URL generation for direct S3 uploads
- Image upload support (JPEG, PNG, WebP)
- Automatic avatar update notifications

### Payment Service

- Stripe integration
- Payment intent creation
- Webhook handling for payment status updates
- Support for multiple currencies

### Email Service

- Transactional email via SendGrid
- Template-based emails
- Queue-based processing with retry logic
- Account verification emails
- Password reset emails

## Tech Stack

- **Framework**: NestJS
- **Language**: TypeScript
- **Databases**: PostgreSQL (via Prisma ORM)
- **Message Broker**: RabbitMQ
- **Cache**: Redis
- **Job Queue**: BullMQ
- **Storage**: AWS S3
- **Payment**: Stripe
- **Email**: SendGrid
- **Validation**: Zod with nestjs-zod
- **Authentication**: Passport.js (JWT & Google OAuth2)

## Project Structure

```
.
├── apps/
│   ├── api-gateway/          # REST API Gateway
│   ├── auth-service/         # Authentication & Authorization
│   ├── user-service/         # User Management
│   ├── media-service/        # File Upload & Storage
│   ├── payment-service/      # Payment Processing
│   └── mail-service/         # Email Notifications
├── libs/
│   └── common/               # Shared DTOs, interfaces, and utilities
├── .github/
│   └── workflows/
│       └── deploy.yml        # CI/CD for Heroku deployment
└── docker-compose.yml        # Local development environment
```

Each service follows Clean Architecture principles:

- `domain/` - Business entities and interfaces
- `application/` - Use cases and business logic
- `infrastructure/` - External dependencies (repositories, adapters, controllers)

## Prerequisites

- Node.js 20+
- pnpm (enabled via corepack)
- Docker & Docker Compose
- PostgreSQL databases (4 separate databases)
- RabbitMQ instance
- Redis instance
- AWS S3 bucket
- Stripe account
- SendGrid account

## Environment Variables

Create a `.env` file in the root directory:

```env
# API Gateway
PORT=3000
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_IOS_CLIENT_ID=your_google_client_id
GOOGLE_ANDROID_CLIENT_ID=your_google_client_id
FRONTEND_URL=http://localhost:3000

# Database URLs
USER_DATABASE_URL=postgresql://user:password@localhost:5432/user_db
AUTH_DATABASE_URL=postgresql://user:password@localhost:5432/auth_db
MEDIA_DATABASE_URL=postgresql://user:password@localhost:5432/media_db
PAYMENT_DATABASE_URL=postgresql://user:password@localhost:5432/payment_db

# RabbitMQ
RABBITMQ_URL=amqp://localhost:5672

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# AWS S3
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_BUCKET_NAME=your_bucket_name

# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# SendGrid
SENDGRID_API_KEY=SG....
SENDGRID_FROM_EMAIL=noreply@yourdomain.com
SENDGRID_CONFIRM_ACCOUNT_TEMPLATE_ID=d-...
SENDGRID_RESET_PASSWORD_TEMPLATE_ID=d-...

# Mail Queue (Redis for BullMQ)
MAIL_QUEUE_HOST=localhost
MAIL_QUEUE_PORT=6379
MAIL_QUEUE_PASSWORD=

# JWT
JWT_SECRET=replace_with_at_least_32_random_characters
# Required by Auth Service; do not use the example value in deployed environments.

# Seeded system identities (generate a unique UUIDv4 for each environment)
DEFAULT_ADMIN_ID=replace_with_a_uuidv4
BOT_USER_ID=replace_with_a_uuidv4

# Webhook Port
WEBHOOK_PORT=3006
```

Generate the system IDs with `node -e "console.log(crypto.randomUUID())"`. Keep
their values consistent for the seed commands and every service deployment. Do
not rotate them against an existing database without a coordinated data
migration, because they identify persisted admin and bot records.

## Installation

```bash
# Install dependencies
pnpm install

# Generate Prisma clients
pnpm prisma:generate:all

# Run database migrations
pnpm migrate:user
pnpm migrate:auth
pnpm migrate:media
pnpm migrate:payment

# Seed default admin user and roles
pnpm seed:all
```

### Default Admin Credentials

After seeding:

- Email: `admin@example.com`
- Password: `admin123`
- Role: `ADMIN`

## Running the Application

### Development Mode

```bash
# Start all services concurrently
pnpm start:all

# Or start services individually
pnpm start:gateway
pnpm start:user
pnpm start:auth
pnpm start:mail
pnpm start:media
pnpm start:payment
```

The API Gateway will be available at `http://localhost:3000/api`

### Using Docker Compose

```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

### Production Mode

```bash
# Build all services
pnpm build:all

# Run migrations
pnpm migrate:user:prod
pnpm migrate:auth:prod
pnpm migrate:media:prod
pnpm migrate:payment:prod

# Seed data
pnpm seed:all

# Start services
pnpm start:prod:gateway
pnpm start:prod:user
pnpm start:prod:auth
pnpm start:prod:mail
pnpm start:prod:media
pnpm start:prod:payment
```

## API Documentation

Swagger documentation is available at `http://localhost:3000/api` when running the API Gateway.

### Key Endpoints

**Authentication**

- `POST /auth/register` - Register new user
- `POST /auth/login` - Login with email/password
- `POST /auth/logout` - Logout user
- `POST /auth/refresh` - Refresh access token
- `GET /auth/google` - Initiate Google OAuth
- `POST /auth/confirm` - Confirm email verification
- `POST /auth/forgot-password` - Request password reset
- `POST /auth/reset-password` - Reset password with token
- `GET /auth/me` - Get current user session

**Users** (Admin only)

- `GET /users` - List all users (paginated)
- `POST /users` - Create user
- `PATCH /users/:id` - Update user
- `DELETE /users/:id` - Delete user

**Media**

- `POST /media/upload-url` - Get pre-signed S3 URL
- `POST /media/confirm` - Confirm upload and update avatar

**Payments**

- `POST /payments` - Create payment intent
- `POST /payments/webhook` - Stripe webhook endpoint

## Database Management

```bash
# Generate Prisma client after schema changes
pnpm prisma:generate:all

# Create a new migration
pnpm migrate:user
pnpm migrate:auth
pnpm migrate:media
pnpm migrate:payment

# Open Prisma Studio for database GUI
pnpm studio:user
pnpm studio:auth
pnpm studio:media
pnpm studio:payment
```

## Deployment

### Heroku (CI/CD)

1. Create Heroku apps for each service
2. Add `HEROKU_API_KEY` to GitHub secrets
3. Push to `main` branch to trigger deployment

### Manual Deployment

Each service has a Dockerfile optimized for production:

```bash
# Build Docker image
docker build -t your-service -f apps/service-name/Dockerfile .

# Run container
docker run -p 3000:3000 --env-file .env your-service
```

## Testing

```bash
# Unit tests
pnpm test

# E2E tests
pnpm test:e2e

# Test coverage
pnpm test:cov
```

## Code Quality

```bash
# Format code
pnpm format

# Lint and fix
pnpm lint
```

## Architecture Patterns

### Clean Architecture

Each microservice follows Clean Architecture principles:

- **Domain Layer**: Business entities and interfaces
- **Application Layer**: Use cases containing business logic
- **Infrastructure Layer**: External concerns (DB, HTTP, message queues)

### SAGA Pattern

Distributed transactions use the SAGA pattern with compensating actions:

- User registration creates user → assigns role → sends verification email
- On failure, rollback actions are triggered to maintain consistency

### Repository Pattern

Data access is abstracted through repository interfaces:

```typescript
export interface IUserRepository {
  save(user: User): Promise<User>;
  findByEmail(email: string): Promise<User | null>;
  // ...
}
```

### Adapter Pattern

External services are wrapped in adapters:

- `UserServiceAdapter` - Communicates with User Service via RabbitMQ
- `MailServiceAdapter` - Sends emails via Mail Service
- `StripeAdapter` - Integrates with Stripe API

## Security Features

- HTTP-only cookies for tokens
- JWT with short-lived access tokens (15 min)
- Refresh token rotation
- Password hashing with bcrypt
- Role-based access control
- Email verification required
- Secure password reset flow
- Environment-based security settings
- Stripe webhook signature verification

## Monitoring & Logging

- Structured logging in all services
- Token cleanup scheduled job (daily)
- Error handling with proper HTTP status codes
- RabbitMQ message acknowledgment
- Email retry logic with exponential backoff

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the UNLICENSED license.

## Support

For issues and questions, please open an issue on GitHub.
