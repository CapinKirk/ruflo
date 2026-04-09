---
description: Salesforce testing conventions for POR — test discovery, data factory, assertions
globs: ["force-app/**/*Test.cls", "force-app/**/*Test*.cls", "force-app/**/__tests__/**"]
---

# Salesforce Testing Rules

## Test Class Naming
- `{ClassName}Test` for unit tests (e.g., `AccountTriggerHandlerTest`)
- `{ClassName}IntegrationTest` for integration tests
- `@IsTest` annotation on class declaration

## Test Data
- ALWAYS use `TestDataFactory.cls` — never create records inline
- NEVER use `@SeeAllData=true`
- Create minimal but sufficient data for each test
- Use `Test.startTest()` / `Test.stopTest()` to reset governor limits

## Assertions
- Assert specific expected values: `System.assertEquals(expected, actual, 'message')`
- NEVER assert just "not null" unless that's the actual requirement
- Include descriptive messages in assertions
- Assert count of results for bulk operations

## Test Discovery (for deployments)
| Changed File | Test Class |
|-------------|------------|
| `FooBar.cls` | `FooBarTest.cls` |
| `{Object}Trigger.trigger` | `{Object}TriggerTest.cls` |
| `{Object}TriggerHandler.cls` | `{Object}TriggerHandlerTest.cls` |
| `{Object}TriggerHelper.cls` | `{Object}TriggerHelperTest.cls` |
| `{Name}Batch.cls` | `{Name}BatchTest.cls` |

## LWC Testing
- Jest tests in `__tests__/` subdirectory
- Test wire adapters, event handling, DOM rendering
- Mock Apex imports with `@salesforce/apex/{Class}.{method}`

## Coverage
- Minimum 75% (Salesforce requirement)
- Target 85%+ for production quality
- Test positive paths, negative paths, bulk operations, and edge cases
