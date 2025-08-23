# pip3 install --upgrade --user google-genai

import os
from dotenv import load_dotenv
from utils.credentials import ensure_google_credentials_from_env

# Load .env and ensure GOOGLE_APPLICATION_CREDENTIALS is set from JSON env
load_dotenv()
ensure_google_credentials_from_env()

YOUR_API_KEY=os.environ["GEMINI_API_KEY"]
GOOGLE_CLOUD_PROJECT=os.environ["GOOGLE_CLOUD_PROJECT"]

print(YOUR_API_KEY)
print(GOOGLE_CLOUD_PROJECT)

# we test both method, api-key abd service account json for vertex ai enterprise
# do not combine them, keep both, in all cases 

from google import genai
from google.genai import types
client = genai.Client(
  # vertexai=True,
  api_key=YOUR_API_KEY
)
# If your image is stored in Google Cloud Storage, you can use the from_uri class method to create a Part object.
IMAGE_URI = "gs://generativeai-downloads/images/scones.jpg"
model = "gemini-2.5-flash"
response = client.models.generate_content(
  model=model,
  contents=[
    "What is shown in this image?",
    # types.Part.from_uri(
    #   file_uri=IMAGE_URI,
    #   mime_type="image/png",
    # ),
  ],
)
print(response.text, end="")


from google import genai
from google.genai import types
client = genai.Client(
  vertexai=True, project=GOOGLE_CLOUD_PROJECT, location="global",
)
# If your image is stored in Google Cloud Storage, you can use the from_uri class method to create a Part object.
# IMAGE_URI = "gs://generativeai-downloads/images/scones.jpg"
model = "gemini-2.5-flash"
response = client.models.generate_content(
  model=model,
  contents=[
    "What is shown in this image?",
    # types.Part.from_uri(
    #   file_uri=IMAGE_URI,
    #   mime_type="image/png",
    # ),
  ],
)
print(response.text, end="")

