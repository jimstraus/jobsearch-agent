# Prompts

Session: 2026-11-18

1. Record all prompts in this session in Prompts.md in ~/Development/CloudFlareProject.

2. `/auto-mode-setup`, then:

   As part of the CloudFlare application there is the following:

   > We plan to fast track candidates who complete an assignment to build a type of AI-powered application on Cloudflare. An AI-powered application should include the following components:
   > LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice
   > Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
   > User input via chat or voice (recommend using Pages or Realtime)
   > Memory or state
   > Find additional documentation here.
   > Note: AI-assisted coding is encouraged, but you have to submit prompt history.

   We're going to use the ~/Development/JobSearch project as a basis. We will use CloudFlare's Agents [https://developers.cloudflare.com/agents/]. A Jobsearch agent will periodically spin up and spawn sub agents to check various job boards for new jobs, the durable storage (SQL) will remember state. The Jobsearch agent will write updates to a Google Sheet for the user to view. The basis for this project is the existing ~/Development/JobFinder project. Ask questions.

3. Will Workers LLama do all that claude is doing in JobFinder? If so, that's good otherwise Claude.
   Chat UI all of the above.
   Let's skip the Google Sheet, keep the equivalent in SQL and use the Chat UI to triage and see new leads.

4. I have an Anthropic key to store as a worker secret. Cloudflare is logged in. I'll add companies by hand, and 6 hours is good.

5. Commit it and push and then check up

6. Yes, show the real error and lower the limit to 3 times
