/**
 * Qwen AI (International) Authentication Adapter
 * Implements chat.qwen.ai API authentication
 */

import axios from 'axios'
import { BaseOAuthAdapter } from './base'
import { extractQwenAiRefreshToken, refreshQwenAiToken } from '../../lib/qwenAiAuth'
import {
  OAuthResult,
  OAuthOptions,
  TokenValidationResult,
  CredentialInfo,
  AdapterConfig,
  OAuthCallbackData,
} from '../types'

const QWEN_AI_API_BASE = 'https://chat.qwen.ai'

const FAKE_HEADERS = {
  Accept: 'application/json',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  Origin: QWEN_AI_API_BASE,
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="144", "Not(A:Brand";v="8", "Google Chrome";v="144"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  source: 'web',
}

export class QwenAiAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'qwen-ai',
      authMethods: ['manual'],
      loginUrl: QWEN_AI_API_BASE,
      apiUrl: QWEN_AI_API_BASE,
    })
  }

  async loginWithToken(providerId: string, token: string): Promise<OAuthResult> {
    this.emitProgress('pending', 'Validating Token...')
    
    try {
      const validation = await this.validateToken({ token })
      
      if (!validation.valid) {
        return {
          success: false,
          providerId,
          providerType: 'qwen-ai',
          error: validation.error || 'Token validation failed',
        }
      }
      
      this.emitProgress('success', 'Token validation successful')
      
      return {
        success: true,
        providerId,
        providerType: 'qwen-ai',
        credentials: { token },
        accountInfo: validation.accountInfo,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Validation request failed'
      return {
        success: false,
        providerId,
        providerType: 'qwen-ai',
        error: errorMessage,
      }
    }
  }

  protected async processCallback(data: OAuthCallbackData): Promise<void> {
    // Qwen AI does not support OAuth callback
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const token = credentials.token
    
    if (!token) {
      return {
        valid: false,
        error: 'Token cannot be empty',
      }
    }
    
    if (token.startsWith('eyJ') && token.split('.').length === 3) {
      try {
        const parts = token.split('.')
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
        
        if (payload.email && payload.email.includes('@guest.com')) {
          return {
            valid: false,
            error: 'Guest account not allowed, please login with a real account',
          }
        }
        
        if (payload && (payload.sub || payload.id || payload.user_id || payload.uid)) {
          const userId = payload.sub || payload.id || payload.user_id || payload.uid
          
          try {
            const userInfo = await this.getUserInfo(token)
            console.log('[QwenAi OAuth] User info:', userInfo)
            
            if (userInfo && userInfo.is_guest === true) {
              return {
                valid: false,
                error: 'Guest account not allowed, please login with a real account',
              }
            }
            
            return {
              valid: true,
              tokenType: 'access',
              accountInfo: {
                userId: userId,
                email: payload.email || userInfo?.email || '',
                name: payload.name || userInfo?.name || payload.email || userId,
              },
            }
          } catch (apiError) {
            console.log('[QwenAi OAuth] API validation failed, using JWT payload only:', apiError)
            return {
              valid: true,
              tokenType: 'access',
              accountInfo: {
                userId: userId,
                email: payload.email || '',
                name: payload.name || payload.email || userId,
              },
            }
          }
        }
      } catch {
        return {
          valid: false,
          error: 'Invalid JWT token',
        }
      }
    }
    
    return {
      valid: false,
      error: 'Token is invalid',
    }
  }

  async getUserInfo(token: string): Promise<Record<string, unknown> | null> {
    try {
      // Official endpoint migrated from chat.qwen.ai/api/v2/user to auth.qwen.ai/api/v2/auths/
      const response = await axios.get('https://auth.qwen.ai/api/v2/auths/', {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          source: 'web',
        },
        timeout: 15000,
        validateStatus: () => true,
      })

      console.log('[QwenAi OAuth] getUserInfo response status:', response.status, 'data.success:', response.data?.success)

      if (response.status !== 200 || !response.data?.success) {
        console.log('[QwenAi OAuth] getUserInfo failed, response:', JSON.stringify(response.data).substring(0, 300))
        return null
      }

      return response.data.data
    } catch (error) {
      console.log('[QwenAi OAuth] getUserInfo error:', error instanceof Error ? error.message : error)
      return null
    }
  }

  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    const refreshToken = extractQwenAiRefreshToken(credentials)

    if (!refreshToken) {
      console.log('[QwenAi OAuth] refreshToken: no refresh_token available')
      return null
    }

    const refreshed = await refreshQwenAiToken(refreshToken)
    if (!refreshed) {
      console.log('[QwenAi OAuth] refreshToken failed')
      return null
    }

    console.log('[QwenAi OAuth] refreshToken succeeded')
    return {
      type: 'access',
      value: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
    }
  }
}

export default QwenAiAdapter
