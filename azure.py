import os
from openai import AzureOpenAI

endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
subscription_key = os.getenv("AZURE_OPENAI_API_KEY")
api_version = os.getenv("AZURE_OPENAI_API_VERSION", "2024-12-01-preview")
deployment = os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o")

if not endpoint or not subscription_key:
    raise RuntimeError(
        "Missing Azure OpenAI configuration. "
        "Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY in your environment."
    )

potential_models = [
    "DeepSeek-R1-0528",
    "DeepSeek-V3.2",
    "gpt-4.1",
    "gpt-4o",
    "gpt-5.2-chat",
    "o4-mini",
]

client = AzureOpenAI(
    api_version=api_version,
    azure_endpoint=endpoint,
    api_key=subscription_key,
)

for deployment in potential_models:

    if deployment == "gpt-5.2-chat" or deployment == "o4-mini":
        response = client.chat.completions.create(
            messages=[
                {
                    "role": "system",
                    "content": "You are a helpful assistant.",
                },
                {
                    "role": "user",
                    "content": "I am going to Paris, what should I see?",
                }
            ],
            max_completion_tokens =16384,
            model=deployment
        )
    else:
            response = client.chat.completions.create(
        messages=[
            {
                "role": "system",
                "content": "You are a helpful assistant.",
            },
            {
                "role": "user",
                "content": "I am going to Paris, what should I see?",
            }
        ],
        max_tokens=4096,
        temperature=1.0,
        top_p=1.0,
        model=deployment
    )


    print("*"*40, deployment, "*"*40)

    print(response.choices[0].message.content)

    print("*"*90)
