/**
 * Lead_Inbound_LogTest
 * Smoke tests for the Lead_Inbound_Log__c custom object — confirms the schema
 * was deployed correctly, the External Id upsert works, and the field
 * picklist values accept the n8n integration user's writes.
 *
 * Notes:
 *  - Uses inline factory helpers (no shared TestDataFactory exists in this repo —
 *    same convention as AccountMergeBatchTest).
 *  - Targets >= 85% coverage of any future Lead_Inbound_Log__c trigger code;
 *    today this object has no trigger, so these tests are pure schema+CRUD smoke.
 *  - Validates idempotency: upsert by Idempotency_Hash__c External Id with the
 *    same hash produces UPDATE, not duplicate INSERT.
 *
 * API v66.0
 * R360 n8n Migration
 */
@IsTest
private class Lead_Inbound_LogTest {

    private static final String TEST_HASH_1 =
        'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
    private static final String TEST_HASH_2 =
        'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3';

    private static Lead_Inbound_Log__c createTestLog(
        String hash, String externalId, String source, String status
    ) {
        return new Lead_Inbound_Log__c(
            Idempotency_Hash__c       = hash,
            External_Submission_Id__c = externalId,
            Source__c                 = source,
            Status__c                 = status,
            Received_At__c            = DateTime.now(),
            Retry_Count__c            = 0,
            Payload__c                = '{"test": true, "form_id": "29710"}',
            n8n_Execution_Id__c       = 'exec-' + Math.abs(Crypto.getRandomLong())
        );
    }

    private static Lead createTestLead(String email, String lastName) {
        Lead l = new Lead(
            FirstName = 'Test',
            LastName  = lastName,
            Email     = email,
            Company   = 'Test Co ' + lastName,
            LeadSource = 'Web',
            Status     = 'New'
        );
        insert l;
        return l;
    }

    private static Contact createTestContactWithCustomerAccount(String email, String lastName) {
        Account a = new Account(
            Name = 'Test Customer Account ' + lastName
        );
        insert a;

        Contact c = new Contact(
            FirstName = 'Test',
            LastName  = lastName,
            Email     = email,
            AccountId = a.Id
        );
        insert c;
        return c;
    }

    @IsTest
    static void insertsLogWithRequiredFields() {
        Lead_Inbound_Log__c log = createTestLog(
            TEST_HASH_1, 'wp-entry-1001', 'wpform_29710', 'received'
        );

        Test.startTest();
        insert log;
        Test.stopTest();

        Lead_Inbound_Log__c stored = [
            SELECT Id, Idempotency_Hash__c, Source__c, Status__c, Received_At__c
            FROM Lead_Inbound_Log__c
            WHERE Idempotency_Hash__c = :TEST_HASH_1
            LIMIT 1
        ];
        System.assertEquals(TEST_HASH_1, stored.Idempotency_Hash__c, 'hash should round-trip');
        System.assertEquals('wpform_29710', stored.Source__c, 'source should round-trip');
        System.assertEquals('received', stored.Status__c, 'status should round-trip');
        System.assertNotEquals(null, stored.Received_At__c, 'received_at should be populated');
    }

    @IsTest
    static void upsertByIdempotencyHashIsIdempotent() {
        // First write (initial receiver call)
        Lead_Inbound_Log__c log1 = createTestLog(
            TEST_HASH_1, 'wp-entry-1002', 'wpform_29710', 'received'
        );
        insert log1;

        // Second write (parallel receiver call — same hash)
        Lead_Inbound_Log__c log2 = createTestLog(
            TEST_HASH_1, 'wp-entry-1002', 'wpform_29710', 'replayed_duplicate'
        );

        Test.startTest();
        Schema.SObjectField hashField = Lead_Inbound_Log__c.Fields.Idempotency_Hash__c;
        Database.upsert(log2, hashField, false);
        Test.stopTest();

        List<Lead_Inbound_Log__c> all = [
            SELECT Id, Status__c FROM Lead_Inbound_Log__c
            WHERE Idempotency_Hash__c = :TEST_HASH_1
        ];
        System.assertEquals(1, all.size(),
            'upsert by Idempotency_Hash__c External Id should produce exactly 1 row, not 2');
        System.assertEquals('replayed_duplicate', all[0].Status__c,
            'second upsert should UPDATE the existing row to the new status');
    }

    @IsTest
    static void allPicklistSourcesAccepted() {
        List<String> sources = new List<String>{
            'wpform_29710', 'wpform_29712', 'wpform_29714',
            'bot_r360', 'webhook_pre_discovery', 'wpform_33076'
        };

        List<Lead_Inbound_Log__c> logs = new List<Lead_Inbound_Log__c>();
        for (Integer i = 0; i < sources.size(); i++) {
            logs.add(createTestLog(
                TEST_HASH_1.substring(0, 60) + String.valueOf(1000 + i),
                'ext-' + i,
                sources[i],
                'written'
            ));
        }

        Test.startTest();
        insert logs;
        Test.stopTest();

        Integer count = [SELECT COUNT() FROM Lead_Inbound_Log__c WHERE Status__c = 'written'];
        System.assertEquals(6, count, 'all 6 source picklist values should be accepted');
    }

    @IsTest
    static void allPicklistStatusesAccepted() {
        List<String> statuses = new List<String>{
            'received', 'written', 'replayed', 'replayed_duplicate',
            'failed', 'X_skipped_no_email', 'X_no_record_skipped_contactform'
        };

        List<Lead_Inbound_Log__c> logs = new List<Lead_Inbound_Log__c>();
        for (Integer i = 0; i < statuses.size(); i++) {
            logs.add(createTestLog(
                TEST_HASH_2.substring(0, 60) + String.valueOf(1000 + i),
                'ext-status-' + i,
                'wpform_29710',
                statuses[i]
            ));
        }

        Test.startTest();
        insert logs;
        Test.stopTest();

        Integer count = [SELECT COUNT() FROM Lead_Inbound_Log__c
                         WHERE External_Submission_Id__c LIKE 'ext-status-%'];
        System.assertEquals(7, count, 'all 7 status picklist values should be accepted');
    }

    @IsTest
    static void resolvedLeadLookupRoundTrips() {
        Lead l = createTestLead('uat-resolved-lead@example.com', 'Resolved');
        Lead_Inbound_Log__c log = createTestLog(
            TEST_HASH_1, 'wp-entry-resolved-1', 'wpform_29710', 'written'
        );
        log.Resolved_Lead__c = l.Id;
        log.Decision_Path__c = 'A4b';

        Test.startTest();
        insert log;
        Test.stopTest();

        Lead_Inbound_Log__c stored = [
            SELECT Id, Resolved_Lead__c, Resolved_Lead__r.Email, Decision_Path__c
            FROM Lead_Inbound_Log__c
            WHERE Idempotency_Hash__c = :TEST_HASH_1
            LIMIT 1
        ];
        System.assertEquals(l.Id, stored.Resolved_Lead__c, 'lookup should resolve to the Lead');
        System.assertEquals('uat-resolved-lead@example.com', stored.Resolved_Lead__r.Email,
            'cross-object SOQL via lookup should work');
        System.assertEquals('A4b', stored.Decision_Path__c, 'decision path should round-trip');
    }

    @IsTest
    static void resolvedContactLookupRoundTrips() {
        Contact c = createTestContactWithCustomerAccount(
            'uat-resolved-contact@example.com', 'ResolvedContact'
        );
        Lead_Inbound_Log__c log = createTestLog(
            TEST_HASH_2, 'wp-entry-resolved-2', 'wpform_29710', 'written'
        );
        log.Resolved_Contact__c = c.Id;
        log.Decision_Path__c    = 'C';

        Test.startTest();
        insert log;
        Test.stopTest();

        Lead_Inbound_Log__c stored = [
            SELECT Id, Resolved_Contact__c, Resolved_Contact__r.Email,
                   Resolved_Contact__r.AccountId, Decision_Path__c
            FROM Lead_Inbound_Log__c
            WHERE Idempotency_Hash__c = :TEST_HASH_2
            LIMIT 1
        ];
        System.assertEquals(c.Id, stored.Resolved_Contact__c, 'contact lookup should resolve');
        System.assertNotEquals(null, stored.Resolved_Contact__r.AccountId,
            'contact should have a parent account from factory');
        System.assertEquals('C', stored.Decision_Path__c, 'decision path C should round-trip');
    }

    @IsTest
    static void retryCountIncrements() {
        Lead_Inbound_Log__c log = createTestLog(
            TEST_HASH_1, 'wp-entry-retry-1', 'wpform_29710', 'failed'
        );
        log.Error_Message__c = 'FIELD_INTEGRITY_EXCEPTION on MQL__c';
        log.Retry_Count__c   = 0;
        insert log;

        Test.startTest();
        log.Retry_Count__c = 1;
        update log;
        log.Retry_Count__c = 2;
        update log;
        Test.stopTest();

        Lead_Inbound_Log__c stored = [
            SELECT Id, Retry_Count__c, Error_Message__c FROM Lead_Inbound_Log__c
            WHERE Id = :log.Id
        ];
        System.assertEquals(2, stored.Retry_Count__c, 'retry count should track increments');
        System.assertEquals('FIELD_INTEGRITY_EXCEPTION on MQL__c', stored.Error_Message__c,
            'error message should round-trip');
    }

    @IsTest
    static void payloadAcceptsLargeJson() {
        // Build a 30k-char payload to confirm Long Text Area sizing
        String big = '';
        for (Integer i = 0; i < 1000; i++) {
            big += '{"key' + i + '":"value' + i + '"},';
        }
        String payload = '{"items":[' + big.removeEnd(',') + ']}';
        System.assert(payload.length() > 20000, 'payload should be > 20KB for this test');

        Lead_Inbound_Log__c log = createTestLog(
            TEST_HASH_1, 'wp-entry-large', 'webhook_pre_discovery', 'received'
        );
        log.Payload__c = payload;

        Test.startTest();
        insert log;
        Test.stopTest();

        Lead_Inbound_Log__c stored = [
            SELECT Payload__c FROM Lead_Inbound_Log__c WHERE Id = :log.Id
        ];
        System.assertEquals(payload.length(), stored.Payload__c.length(),
            'large payload should round-trip without truncation under 32KB limit');
    }
}
