# My AI Companion

MASTER PROMPT — COMPLETE PRIVATE AI CHAT / MEMORY REPLICA APP

==============================================================



IMPORTANT:

This is a completely NEW Lovable project.



You have NO knowledge of my previous project, so everything you need to know is written below.



I have LIMITED Lovable credits.



BUILD THE COMPLETE APPLICATION IN ONE CONTINUOUS IMPLEMENTATION.



Do NOT unnecessarily split this into phases.

Do NOT ask me to approve every small step.

Do NOT build only the frontend.

Do NOT leave placeholder functionality.

Do NOT create temporary architecture that will later need to be rebuilt.



Build the complete working full-stack application and then perform a complete verification/debug pass before finishing.



==============================================================

1. WHAT WE ARE BUILDING

==============================================================



Build a private AI chat/memory application where an authenticated user can:



- Sign in

- Upload conversation/chat exports

- Upload ZIP files containing conversation data

- Import/process conversation history

- Create AI replicas/personas from conversation data

- Analyze the communication style of the source person

- Store memories

- Store conversation history

- Search/retrieve relevant memories

- Chat with an AI replica

- Generate responses using Grok

- Store generated responses

- Manage multiple replicas

- Manage chat sessions

- Upload images/media where supported

- View uploaded memories/media

- Maintain persistent chat history

- Use the application on mobile and desktop



The application must feel like a complete production application, not a demo.



==============================================================

2. ABSOLUTE ARCHITECTURE

==============================================================



Use exactly this architecture:



FIREBASE

--------

Firebase is ONLY for authentication.



Firebase must NOT be used for:



- Database

- Storage

- Chat data

- Memories

- Uploaded files

- Replica data

- Conversation data

- AI response storage



SUPABASE

--------

Supabase is the application's backend/data platform for:



- PostgreSQL database

- Row Level Security

- Storage

- Uploaded files

- Memories

- Conversations

- Messages

- Replicas

- Chat sessions

- Generated responses

- Processing jobs

- Profiles

- Embeddings/vector search

- Application data



GROK

----

Grok is used for AI generation.



Grok API secrets MUST remain server-side.



Never expose the Grok secret in browser JavaScript.



==============================================================

3. MOST IMPORTANT PART:

FIREBASE → SUPABASE AUTHENTICATION

==============================================================



This was the MAIN FAILURE in the previous project.



DO NOT repeat it.



The user authenticates with Firebase.



After Firebase authentication:



Firebase Login

      ↓

Firebase authenticated user

      ↓

Firebase ID token

      ↓

Correct Firebase/Supabase third-party authentication integration

      ↓

Supabase authenticated session/identity

      ↓

Database + Storage

      ↓

RLS validates the authenticated user



IMPORTANT:



Simply passing a Firebase ID token into a generic Supabase access-token field is NOT sufficient unless Supabase is actually configured to validate that token and establish the correct authenticated identity.



Implement a PROPER supported Firebase → Supabase authentication/third-party JWT integration.



The Supabase side must actually recognize the authenticated Firebase user.



Before database or storage operations are allowed:



1. Firebase user must exist.

2. Firebase ID token must be available.

3. Supabase authentication must be established correctly.

4. Supabase session must exist.

5. Supabase must resolve the authenticated user's identity.

6. The application must verify that identity.

7. Only then should database/storage operations proceed.



DO NOT attempt to fix authentication by weakening RLS.



DO NOT create public database access just because authentication is broken.



DO NOT create public storage access just because authentication is broken.



==============================================================

4. AUTHENTICATION DIAGNOSTICS

==============================================================



Create a development-only authentication diagnostics system.



It must be able to show:



Firebase:

- signed in: yes/no

- Firebase UID

- token available: yes/no



Supabase:

- session available: yes/no

- authenticated user ID

- access token available: yes/no



NEVER display the actual token.



The diagnostic must immediately reveal:



Firebase authenticated

BUT

Supabase unauthenticated



if that occurs.



If this happens, STOP database/storage testing and fix the authentication bridge first.



Do not modify RLS to hide the problem.



Disable sensitive diagnostics in production.



==============================================================

5. ENVIRONMENT VARIABLES

==============================================================



DO NOT hard-code secrets.



Use environment variables.



Supabase:



VITE_SUPABASE_URL

VITE_SUPABASE_PUBLISHABLE_KEY



Supabase project URL:



https://lqozgmshdwvfbeyonmpy.supabase.co



Use the Supabase publishable key supplied by me through the environment/secrets configuration.



DO NOT hard-code the key into source code.



Firebase:



VITE_FIREBASE_API_KEY

VITE_FIREBASE_AUTH_DOMAIN

VITE_FIREBASE_PROJECT_ID

VITE_FIREBASE_STORAGE_BUCKET

VITE_FIREBASE_MESSAGING_SENDER_ID

VITE_FIREBASE_APP_ID



Use my Firebase project's actual web configuration through environment variables.



Grok:



GROK_API_KEY



GROK_API_KEY MUST ONLY be available server-side.



Never expose it through VITE_ variables.



Never put it directly in frontend code.



==============================================================

6. GROK ARCHITECTURE

==============================================================



AI requests must use:



Frontend

   ↓

Authenticated backend/server/edge function

   ↓

Verify authenticated user

   ↓

Retrieve replica/context/memories

   ↓

Grok API

   ↓

Store generated response

   ↓

Return response to frontend



The browser must NEVER receive the Grok secret.



Handle:



- timeout

- API failure

- rate limit

- invalid response

- network error

- retry

- loading state

- failed generation



==============================================================

7. SUPABASE STORAGE

==============================================================



Use SUPABASE STORAGE ONLY.



DO NOT use Firebase Storage.



I already have these Supabase Storage buckets:



1. memories

2. chat-uploads



Use those existing buckets.



Do NOT create duplicate buckets such as:



chat_uploads

chat_upload

chat-files

chat-uploads-2



unless there is a genuine technical requirement.



The application must support relevant uploads including:



- ZIP

- TXT

- JSON

- CSV

- images

- supported media

- conversation exports



The upload system must not depend on one exact filename.



==============================================================

8. STORAGE PATH STRUCTURE

==============================================================



Use authenticated-user-specific paths.



Example:



chat-uploads/<USER_ID>/<FILE>



memories/<USER_ID>/<FILE>



The exact implementation may be improved, but user ownership must always be clear and enforceable.



A user must NEVER be able to access another user's files.



==============================================================

9. STORAGE RLS

==============================================================



Storage RLS must remain enabled.



DO NOT disable RLS.



DO NOT use:



WITH CHECK (true)



for production user uploads.



DO NOT create public unrestricted upload policies.



Create minimal, clean policies for:



- INSERT

- SELECT

- UPDATE

- DELETE



for the user's own files.



Policies must verify authenticated identity and folder ownership.



Avoid duplicate policies.



Do not create dozens of overlapping policies.



Before creating policies:



1. Inspect existing policies.

2. Remove only conflicting/obsolete policies.

3. Create the final clean policy set.



==============================================================

10. DATABASE RLS

==============================================================



Every user-owned table must have RLS enabled.



Use clean, minimal policies.



Do NOT repeatedly create and drop policies during normal application operation.



Do NOT use unrestricted public policies.



Do NOT trust owner_id supplied by the browser without verification.



Ownership must be enforced database-side.



User-owned tables include:



profiles

replicas

source_files

memory_items

memory_embeddings

conversations

messages

chat_sessions

chat_session_messages

generated_responses

processing_jobs

replica_participants

replica_style_profiles



==============================================================

11. DATABASE TABLES / DATA MODEL

==============================================================



Support the following structures.



profiles:



user_id

display_name

email

avatar_url

created_at

updated_at



replicas:



id

owner_id

name

description

avatar_url

source_filename

source_file_path

status

message_count

created_at

updated_at



source_files:



id

owner_id

replica_id

bucket_name

storage_path

original_filename

mime_type

file_size

status

error_message

created_at

processed_at



memory_items:



id

owner_id

replica_id

bucket_name

storage_path

title

description

media_type

metadata

created_at



memory_embeddings:



id

memory_id

replica_id

embedding

model_name

dimension

created_at



conversations:



id

replica_id

title

source_platform

started_at

ended_at

message_count

created_at



messages:



id

replica_id

conversation_id

participant_id

sender_role

sender_name

message_text

message_type

media_path

original_message_id

reply_to_message_id

sent_at

source_platform

metadata

created_at



chat_sessions:



id

owner_id

replica_id

title

created_at

updated_at



chat_session_messages:



id

session_id

sender_role

message_text

media_path

media_type

generated_response_id

created_at



generated_responses:



id

replica_id

owner_id

user_message

generated_response

retrieval_context

generation_metadata

created_at



processing_jobs:



id

owner_id

replica_id

source_file_id

job_type

status

progress

total_items

processed_items

error_message

metadata

created_at

started_at

completed_at



replica_participants:



id

replica_id

display_name

role

original_identifier

message_count

created_at



replica_style_profiles:



replica_id

language_profile

humor_profile

emoji_profile

punctuation_profile

vocabulary_profile

response_length_profile

greeting_profile

personality_profile

custom_instructions

analysis_version



Create appropriate:



- foreign keys

- indexes

- constraints

- timestamps



==============================================================

12. USER PROFILE

==============================================================



After Firebase authentication:



Create or update the corresponding Supabase profile.



Store:



- Firebase user ID / mapped authenticated identity

- display name

- email

- avatar



Do not create duplicate profiles on every login.



Use upsert logic where appropriate.



==============================================================

13. FILE UPLOAD FLOW

==============================================================



Complete flow:



User logs in

↓

Verify Firebase authentication

↓

Verify Supabase authenticated session

↓

Verify Supabase identity

↓

Select file

↓

Validate file

↓

Validate size/type

↓

Upload to Supabase Storage

↓

Create source_files record

↓

Create processing_jobs record

↓

Process file

↓

Extract conversations

↓

Extract messages

↓

Detect participants

↓

Analyze style

↓

Create/update replica

↓

Generate memories

↓

Generate embeddings where available

↓

Update progress

↓

Complete processing

↓

Show result



If anything fails:



- show useful error

- record error

- update processing status

- allow retry

- never display fake success



==============================================================

14. ZIP UPLOADS

==============================================================



ZIP uploads are CRITICAL.



The application MUST support ZIP uploads.



The previous application repeatedly produced:



"new row violates row-level security policy for table objects"



and:



HTTP 400



on:



/storage/v1/object/chat-uploads/...



This MUST NOT happen.



Before upload:



- Firebase authentication verified

- Supabase authentication verified

- Supabase session verified

- user identity verified

- bucket verified

- path verified

- storage permissions verified



Only then upload.



After upload:



- verify object exists

- create database record

- process ZIP

- update progress



==============================================================

15. CHAT EXPORT IMPORT

==============================================================



The application should be flexible with conversation exports.



Support different common formats where possible.



Detect:



- TXT

- JSON

- CSV

- ZIP

- common exported chat structures



Do NOT assume that every file has exactly the same format.



Create a parser architecture where different formats can be detected and processed safely.



If a format cannot be recognized:



Show:



"Unsupported or unrecognized conversation format"



and explain what is needed.



Do not crash.



==============================================================

16. REPLICA SYSTEM

==============================================================



Users can create multiple replicas.



Replica features:



- create

- edit

- rename

- avatar

- description

- delete

- view processing status

- view message count

- view participants

- view style profile

- select replica for chatting



Each replica belongs to exactly one authenticated owner.



Deleting a replica should safely handle associated:



- source files

- conversations

- messages

- memories

- embeddings

- processing jobs

- style profile



Do not leave uncontrolled orphan data.



==============================================================

17. PARTICIPANT DETECTION

==============================================================



During conversation processing:



Detect participants.



Store:



- display name

- role

- original identifier

- message count



Allow the application to identify which participant the replica should represent.



==============================================================

18. STYLE ANALYSIS

==============================================================



Analyze source conversations for:



- language

- vocabulary

- common phrases

- punctuation

- emoji usage

- humor

- response length

- greeting patterns

- personality traits

- conversational style



Store this in:



replica_style_profiles



Use this profile during AI generation.



==============================================================

19. MEMORY SYSTEM

==============================================================



Implement persistent memory.



Memories may contain:



- text

- title

- description

- source

- metadata

- media

- replica association



Support:



- create

- read

- search

- delete

- update



Memory retrieval should be relevant to the user's current conversation.



==============================================================

20. VECTOR SEARCH

==============================================================



Use pgvector/vector embeddings where available.



Store:



- embedding

- model

- dimension

- memory association

- replica association



Use semantic retrieval for relevant memories.



If embeddings fail:



The chat system must still function using normal database retrieval.



Do not make the entire application unusable because vector generation fails.



==============================================================

21. CHAT SYSTEM

==============================================================



Implement a complete chat system.



Features:



- select replica

- create chat session

- continue previous session

- send messages

- receive AI responses

- timestamps

- message history

- reply-to-message support

- media attachments where supported

- image uploads

- supported video/audio uploads

- loading state

- retry

- error state

- auto-scroll

- mobile-friendly interface



Store chat messages in Supabase.



==============================================================

22. MEDIA

==============================================================



Use Supabase Storage for supported media.



Support:



- images

- audio/voice messages

- video

- file attachments



Implement sensible file-size/type validation.



Do not allow invalid files to silently upload.



Compress images where appropriate before upload.



For large media:



- show upload progress

- handle failure

- retry when possible



==============================================================

23. MEDIA LIBRARY

==============================================================



Create a media/library area where the user can see their uploaded media/files.



Show:



- filename

- type

- size

- date

- associated replica/session where relevant



Allow:



- preview where supported

- download

- delete



Only show files belonging to the authenticated user.



==============================================================

24. CONVERSATION HISTORY

==============================================================



Users should be able to:



- view conversations

- open conversations

- continue conversations

- search conversations

- delete conversations

- see timestamps

- see message counts



Chat history must persist after logout/login.



==============================================================

25. CHAT SESSION MANAGEMENT

==============================================================



Support:



- new chat

- existing chats

- rename chat

- delete chat

- select replica

- continue session

- session timestamps



Do not lose chat history on page refresh.



==============================================================

26. AI GENERATION

==============================================================



When user sends:



"Hello"



The backend should:



1. Verify user.

2. Verify replica ownership.

3. Load replica style profile.

4. Retrieve relevant memories.

5. Retrieve relevant conversation context.

6. Construct AI prompt.

7. Call Grok securely.

8. Receive response.

9. Store generated response.

10. Return response.



AI must NOT access another user's data.



==============================================================

27. SECURITY

==============================================================



Never:



- expose service-role keys

- expose Grok secret

- disable RLS

- make user data public

- create unrestricted database policies

- create unrestricted storage policies

- trust client ownership

- use Firebase Storage

- put secrets in frontend source

- bypass authentication to make uploads work



Keep security simple and correct.



The objective is:



AUTHENTICATION FIRST

↓

AUTHORIZED SUPABASE SESSION

↓

RLS

↓

USER DATA



==============================================================

28. MOBILE + DESKTOP

==============================================================



The application must be responsive.



Mobile:



- touch-friendly

- proper navigation

- readable chat

- upload controls usable

- no horizontal overflow

- no broken dialogs

- no overlapping elements



Desktop:



- proper sidebar/layout

- efficient workspace

- readable tables/cards

- no stretched mobile UI



Automatically adapt to viewport size.



==============================================================

29. PWA

==============================================================



Make the application installable as a PWA where supported.



Include:



- manifest

- icons

- responsive layout

- proper mobile behavior

- appropriate theme

- service worker only if it does not interfere with authentication/session behavior



Do not cache sensitive authenticated data incorrectly.



==============================================================

30. ERROR HANDLING

==============================================================



Every async operation needs:



- loading

- success

- error

- retry where appropriate



Differentiate:



Firebase authentication errors

Supabase authentication errors

RLS errors

Storage errors

Database errors

File validation errors

Processing errors

Grok errors

Network errors

Expired sessions

Differentiate:



Firebase authentication errors

Supabase authentication errors

RLS errors

Storage errors

Database errors

File validation errors

Processing errors

Grok errors

Network errors

Expired sessions



Do not simply show:



"Something went wrong."



Development logs should contain useful technical information.



Production UI should show a clean user-friendly explanation.



==============================================================

31. REST API 401 PROBLEM

==============================================================



The previous application repeatedly generated:



GET /rest/v1/ → 401



Do NOT ignore this.



A 401 authentication problem must NOT be "fixed" by changing RLS.



Verify:



- Supabase URL

- publishable key

- authenticated session

- access token

- token refresh

- authorization header

- Supabase identity

- Firebase/Supabase integration



Do not make unnecessary unauthenticated REST calls.



==============================================================

32. STORAGE 400 / OBJECTS RLS PROBLEM

==============================================================



The previous application repeatedly generated:



42501:

new row violates row-level security policy for table "objects"



followed by:



400 POST /storage/v1/object/chat-uploads/...



This is specifically a Storage authentication/authorization problem.



Do NOT blindly create more policies.



Correct order:



1. Verify Firebase user.

2. Verify Supabase session.

3. Verify Supabase user identity.

4. Verify bucket.

5. Verify path.

6. Verify storage INSERT policy.

7. Test upload.

8. Verify object.

9. Test download/read.

10. Test update.

11. Test delete.



==============================================================

33. NO POLICY MESS

==============================================================



The previous project accumulated many duplicate storage policies.



DO NOT do that.



Keep the final policy set clean.



Before creating policies:



Inspect current policies.



Create only the required policies.



Use consistent names.



Do not repeatedly create:



chat_uploads_insert

chat_uploads_insert_own

allow_storage_upload

Users can upload their own chat uploads

etc.



unless there is a genuine reason.



One clean policy should handle the intended access.



==============================================================

34. SESSION MANAGEMENT

==============================================================



Handle:



- login

- logout

- refresh

- token expiry

- page reload

- browser restart

- mobile browser

- expired Firebase token

- Supabase session state



Do not let the UI claim the user is authenticated when Supabase authentication is actually missing.



==============================================================

35. LOGOUT SECURITY

==============================================================



On logout:



- clear local authenticated state

- invalidate/clear Supabase session state as appropriate

- clear cached user-specific data

- prevent protected API calls

- prevent uploads

- prevent database access



After logging in again:



- restore correct authenticated session

- load only that user's data



==============================================================

36. DUPLICATE UPLOAD PROTECTION

==============================================================



Prevent accidental duplicate processing.



If the same file is uploaded repeatedly:



- detect where practical

- avoid unnecessary duplicate processing

- show processing status

- prevent multiple simultaneous jobs for the same source where possible



==============================================================

37. PROCESSING JOB SYSTEM

==============================================================



Processing should show:



0%

↓

10%

↓

...

↓

100%



Display:



- current status

- processed items

- total items

- errors

- completion



Statuses can include:



pending

processing

completed

failed



If processing fails:



Store error_message.



Allow retry.



==============================================================

38. BACKGROUND/LONG PROCESSING

==============================================================



Large ZIP files and conversation histories may take time.



Do not freeze the UI.



Use asynchronous/background processing where appropriate.



The user should be able to see progress.



The application should not depend on one giant blocking browser operation.



==============================================================

39. SEARCH

==============================================================



Implement useful search for:



- conversations

- messages

- memories

- replicas



Use semantic search for memories when available.



Use normal database search for basic text search.



==============================================================

40. PROFILE

==============================================================



Profile/settings should support:



- display name

- email

- avatar

- account information

- logout



Do not allow users to modify protected ownership IDs.



==============================================================

41. DATA OWNERSHIP

==============================================================



Every user-owned object must have a clear ownership chain.



Example:



Authenticated User

    ↓

Replica

    ↓

Conversation

    ↓

Messages



and:



Authenticated User

    ↓

Replica

    ↓

Memory

    ↓

Embedding



and:



Authenticated User

    ↓

Source File

    ↓

Processing Job



and:



Authenticated User

    ↓

Chat Session

    ↓

Chat Messages

    ↓

Generated Response



RLS must enforce this ownership.

42. DATABASE + STORAGE CLEANUP

==============================================================



When deleting user-owned resources:



Clean up associated records/files safely.



Do not delete another user's data.



Handle failed cleanup gracefully.



==============================================================

43. FINAL END-TO-END RUNNING SESSION

==============================================================



THIS IS MANDATORY.



Before declaring the project complete, perform a complete running-session verification.



TEST 1:

Open application.



TEST 2:

Firebase login.



TEST 3:

Verify Firebase authenticated user.



TEST 4:

Verify Firebase UID exists.



TEST 5:

Verify Firebase token exists without displaying it.



TEST 6:

Verify Supabase authentication bridge.



TEST 7:

Verify Supabase session exists.



TEST 8:

Verify Supabase authenticated identity.



TEST 9:

Verify Supabase identity corresponds correctly to Firebase identity.



TEST 10:

Create/update profile.



TEST 11:

Read profile.



TEST 12:

Create replica.



TEST 13:

Upload TXT.



TEST 14:

Upload ZIP.



TEST 15:

Verify Storage object.



TEST 16:

Verify source_files record.



TEST 17:

Verify processing_jobs record.



TEST 18:

Process conversation.



TEST 19:

Detect participants.



TEST 20:

Create style profile.



TEST 21:

Create memories.



TEST 22:

Create embeddings if available.



TEST 23:

Open chat.



TEST 24:

Send message.



TEST 25:

Retrieve memory/context.



TEST 26:

Call Grok through secure backend.



TEST 27:

Store generated response.



TEST 28:

Reload browser.



TEST 29:

Verify chat history persists.



TEST 30:

Logout.



TEST 31:

Verify protected operations fail correctly while logged out.



TEST 32:

Login again.



TEST 33:

Verify previous data returns.



TEST 34:

Verify another user's data cannot be accessed.



TEST 35:

Test mobile layout.



TEST 36:

Test desktop layout.



TEST 37:

Check browser console for relevant errors.



TEST 38:

Check Supabase logs for relevant authentication/RLS/storage errors.



TEST 39:

Check that no REST 401 is caused by missing authentication.



TEST 40:

Check that no Storage "new row violates row-level security policy" error occurs.



If any test fails:



DO NOT simply report the failure.



Find the root cause.



Fix it.



Run the failed test again.



Continue until the complete flow works.



==============================================================

44. FINAL SECURITY AUDIT

==============================================================



Before completion verify:



[ ] No service-role key in frontend

[ ] No Grok secret in frontend

[ ] No Firebase Storage

[ ] No unrestricted database policy

[ ] No unrestricted storage policy

[ ] RLS enabled

[ ] User isolation works

[ ] Storage isolation works

[ ] Authentication works

[ ] Supabase identity works

[ ] Token refresh works

[ ] Logout works

[ ] Protected endpoints reject unauthenticated users

[ ] Another user cannot read this user's data

[ ] Another user cannot upload into this user's folder

[ ] Another user cannot delete this user's files



==============================================================

45. FINAL FUNCTIONALITY AUDIT

==============================================================



Before completion verify:



[ ] Firebase login

[ ] Supabase authorization

[ ] Profile

[ ] Dashboard

[ ] Replica creation

[ ] Replica editing

[ ] Replica deletion

[ ] Replica selection

[ ] File upload

[ ] ZIP upload

[ ] TXT upload

[ ] JSON/CSV support where applicable

[ ] Image upload

[ ] Audio/voice upload

[ ] Video upload

[ ] Media library

[ ] Conversation import

[ ] Participant detection

[ ] Message extraction

[ ] Processing jobs

[ ] Processing progress

[ ] Memory system

[ ] Vector search

[ ] Conversation history

[ ] Chat sessions

[ ] Chat messages

[ ] Reply support

[ ] AI generation

[ ] Grok backend

[ ] Generated response storage

[ ] Search

[ ] Logout

[ ] Re-login

[ ] Mobile UI

[ ] Desktop UI

[ ] PWA/installability

[ ] Error handling

[ ] Retry handling

[ ] Session persistence

[ ] User data isolation



==============================================================

46. IMPORTANT CREDIT-SAVING RULE

==============================================================



I have LIMITED Lovable credits.



Therefore:



DO NOT unnecessarily split the implementation.



DO NOT make me send another prompt just to connect the backend.



DO NOT make temporary versions.



DO NOT build a fake/mock database.



DO NOT build mock authentication.



DO NOT leave TODOs for critical functionality.



DO NOT repeatedly rebuild the same architecture.



Implement the complete application in ONE continuous build.



After implementation, run the verification pass and fix the issues you discover.



==============================================================

47. FINAL ROOT-CAUSE RULE

==============================================================



If something fails:



DO NOT immediately modify security policies.



First determine which layer failed:



Layer 1:

Firebase authentication



Layer 2:

Firebase → Supabase authentication bridge



Layer 3:

Supabase session



Layer 4:

Supabase identity



Layer 5:

Database authorization/RLS



Layer 6:

Storage authorization



Layer 7:

Application logic



Layer 8:

Grok/backend



Fix the actual failing layer.



Never weaken security to hide an authentication problem.



==============================================================

48. FINAL INSTRUCTION

==============================================================



BUILD THE COMPLETE APPLICATION NOW.



This must be a real working full-stack application.



The final architecture MUST be:



Firebase

= authentication ONLY



Supabase

= database + storage + application backend



Grok

= secure server-side AI generation



The most important requirement is that Firebase authentication correctly establishes a Supabase-authenticated identity so that:



authenticated user

        ↓

Supabase session

        ↓

correct user identity

        ↓

RLS

        ↓

database/storage access



works reliably.



Do NOT repeat the previous project's:



- auth.uid() NULL

- Supabase 401

- Storage 400

- objects RLS error

- broken ZIP upload

- duplicate policy problem

- token synchronization problem

- public-policy workaround

- Firebase/Supabase authorization mismatch



Build everything correctly from the beginning.



After building:



RUN THE COMPLETE END-TO-END TEST.



IF SOMETHING FAILS:

FIND ROOT CAUSE → FIX → RETEST.



Do not declare the project complete until the core authentication, database, storage, upload, processing, replica, memory, chat, and Grok flows have been verified.

==============================================================

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/daac36e1-088e-4dd5-b36b-18c65eff44ea).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
