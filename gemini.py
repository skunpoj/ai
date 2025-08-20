from google import genai
from google.genai import types
import os
from dotenv import load_dotenv
from utils.credentials import ensure_google_credentials_from_env

# Load .env and ensure GOOGLE_APPLICATION_CREDENTIALS is set from JSON env
load_dotenv()
ensure_google_credentials_from_env()

client = genai.Client(
  vertexai=True, project="da-proof-of-concept", location="global",
)
# If your image is stored in Google Cloud Storage, you can use the from_uri class method to create a Part object.
IMAGE_URI = "gs://generativeai-downloads/images/scones.jpg"
model = "gemini-2.5-flash"
response = client.models.generate_content(
  model=model,
  contents=[
    "What is shown in this image?",
    types.Part.from_uri(
      file_uri=IMAGE_URI,
      mime_type="image/png",
    ),
  ],
)
print(response.text, end="")